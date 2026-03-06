# Processing Pipeline Architecture

This document describes the file processing pipeline for eise.app, including all supported formats, edge cases, and the two-phase processing approach.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FILE INPUT                                      │
├─────────────────┬─────────────────┬──────────────────┬──────────────────────┤
│ SER files       │ Raw Bayer AVI   │ RGB AVI/Video    │ Images              │
│ (.ser)          │ (Y800, DIB 8bit)│ (MP4, MOV, etc)  │ (PNG, JPG, TIFF)    │
└────────┬────────┴────────┬────────┴────────┬─────────┴──────────┬───────────┘
         │                 │                 │                    │
         ▼                 ▼                 ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FORMAT DETECTION                                   │
│                         (FileUploader.vue)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ├── Needs demosaicing? ──────────────────┐
         │   (SER with colorID 8-11,              │
         │    AVI with Y800/DIB 8-bit Bayer)      │
         │                                        ▼
         │                          ┌─────────────────────────────┐
         │                          │    useDebayerReader.js      │
         │                          │    (unified demosaic path)  │
         │                          └─────────────────────────────┘
         │
         ├── Already RGB? ────────────────────────┐
         │   (Uncompressed AVI DIB 24-bit,        │
         │    decoded video frames)               ▼
         │                          ┌─────────────────────────────┐
         │                          │    useDirectReader.js       │
         │                          │    (no demosaic needed)     │
         │                          └─────────────────────────────┘
         │
         └── Needs FFmpeg? ───────────────────────┐
             (MP4, MOV, compressed video,         │
              unsupported formats)                ▼
                                    ┌─────────────────────────────┐
                                    │    useFfmpegReader.js       │
                                    │    (decode → PNG → direct)  │
                                    └─────────────────────────────┘
```

---

## Format Parsers

Small, focused modules that only handle format-specific parsing.

### useSerParser.js (~200 lines)

**Responsibilities:**
- Parse 178-byte SER V3 header
- Calculate frame offsets (linear: `178 + index * frameSize`)
- Extract Bayer pattern from `colorID` field
- Detect bit depth (8, 10, 12, 14, 16-bit)
- Handle little/big endian

**SER Header Structure:**
```
Offset  Size  Field
0-13    14    FileID ("LUCAM-RECORDER")
14-17   4     LuID (camera ID)
18-21   4     ColorID (0=MONO, 8=RGGB, 9=GRBG, 10=GBRG, 11=BGGR)
22-25   4     LittleEndian flag
26-29   4     Width
30-33   4     Height
34-37   4     PixelDepthPerPlane (bits per pixel)
38-41   4     FrameCount
42-49   8     Observer (string)
50-89   40    Instrument (string)
90-129  40    Telescope (string)
130-137 8     DateTime (timestamp)
138-145 8     DateTimeUTC (timestamp)
```

**ColorID Mapping:**
| ColorID | Pattern | OpenCV Code | GPU Pattern Index |
|---------|---------|-------------|-------------------|
| 0 | MONO | N/A | -1 |
| 8 | RGGB | COLOR_BayerBG2RGB | 0 |
| 9 | GRBG | COLOR_BayerGB2RGB | 2 |
| 10 | GBRG | COLOR_BayerGR2RGB | 3 |
| 11 | BGGR | COLOR_BayerRG2RGB | 1 |

Note: OpenCV uses inverted Bayer naming convention (see CLAUDE.md for details).

**Edge Cases & Workarounds:**

#### 1. Header Lying About Bit Depth
Some SER files have incorrect pixelDepth in header (says 16-bit but actually 8-bit):
- Calculate expected frame count for both 8-bit and 16-bit
- If 8-bit calculation matches header frameCount, treat as 8-bit

```javascript
const frameSize16 = width * height * 2;
const frameSize8 = width * height * 1;
const dataSize = file.size - 178;
const frameCount8 = Math.floor(dataSize / frameSize8);
if (frameCount8 === header.frameCount) {
    // Actually 8-bit data despite header saying 16-bit
    header.pixelDepth = 8;
}
```

#### 2. Frame Count Validation
Header frameCount can be incorrect:
- Calculate actual frame count from file size
- Use calculated value if different from header

```javascript
const actualFrameCount = Math.floor((file.size - 178) / frameSize);
if (actualFrameCount !== header.frameCount) {
    header.frameCount = actualFrameCount;
}
```

#### 3. Sub-16-bit Data in 16-bit Container
16-bit SER files often contain 8/10/12/14-bit data:
- Sample pixels to find max value
- Compute scale factor to expand to full 16-bit range

```javascript
// Detect effective bit depth from max value
if (maxVal <= 255) effectiveBits = 8;
else if (maxVal <= 1023) effectiveBits = 10;
else if (maxVal <= 4095) effectiveBits = 12;
else if (maxVal <= 16383) effectiveBits = 14;
else effectiveBits = 16;

// Scale to full range
const scaleFactor = 65535 / ((1 << effectiveBits) - 1);
```

---

### useAviParser.js (~300 lines)

**Responsibilities:**
- Parse RIFF/AVI structure
- Detect FourCC codec
- Build frame index (offset + size for each frame)
- Extract Bayer pattern from strd chunk
- Handle vertical flip for bottom-up DIB storage
- Support AVI files without frame count in header (pre-scan)

**Supported FourCC Codes:**
| FourCC | Type | Needs Demosaic |
|--------|------|----------------|
| `DIB ` (0x20424944) | 8-bit raw Bayer or 24-bit RGB | Yes (8-bit) / No (24-bit) |
| `Y800` | 8-bit grayscale/Bayer | Yes |
| `YUY2` | YUV 4:2:2 | No (convert to RGB) |
| `UYVY` | YUV 4:2:2 | No (convert to RGB) |
| `RGB ` | 24-bit RGB | No |
| `MJPG` | Motion JPEG | No (decode each frame) |
| null/0 | FFmpeg rawvideo | Depends on source |

**Edge Cases & Workarounds:**

#### 1. Vertical Flip (Bottom-Up DIB Storage)
DIB format stores frames bottom-up. Detection:
- Check `biHeight` in BITMAPINFOHEADER (positive = bottom-up)
- Apply `flipFrameVertically()` during frame reading

```javascript
// Frame needs flip if DIB and height is positive (bottom-up)
if (fourcc === 'DIB ' && biHeight > 0) {
    flipFrameVertically(frameData, width, height, bytesPerPixel);
}
```

#### 2. AVI Files Without Frame Count Header
Some AVI files have incorrect or zero frame count in header.
- **Solution**: Pre-scan the movi chunk to count actual frames
- Scan for chunk headers matching pattern `\d\ddc` or `\d\ddb`
- Build frame index array with actual offsets

```javascript
// Pre-scan when header frame count is 0 or suspicious
if (headerFrameCount === 0 || headerFrameCount > 1000000) {
    frameIndex = scanMoviChunkForFrames(file, moviOffset, moviSize);
}
```

#### 3. Bayer Pattern Detection from strd Chunk
Raw Bayer AVI files may have pattern info in stream data chunk:
- Search for strings: "RGGB", "BGGR", "GRBG", "GBRG"
- Fallback to RGGB if not found

```javascript
// Search strd chunk for Bayer pattern string
const strdText = new TextDecoder().decode(strdChunk);
if (strdText.includes('RGGB')) bayerPattern = 'RGGB';
else if (strdText.includes('BGGR')) bayerPattern = 'BGGR';
// ... etc
else bayerPattern = 'RGGB'; // Default fallback
```

#### 4. 8-bit vs 24-bit DIB Detection
DIB can be either 8-bit Bayer or 24-bit RGB:
- Check `biBitCount` in BITMAPINFOHEADER
- 8 = raw Bayer, needs demosaic
- 24 = RGB, no demosaic needed

#### 5. OpenDML/AVI 2.0 Large Files (>2GB)
Large AVI files use AVIX extension chunks to store additional frames:
- First RIFF chunk has standard movi list
- Additional RIFF AVIX chunks contain more frames
- **Solution**: Scan entire file, not just first movi chunk

```javascript
// For large files, scan beyond movi chunk to find AVIX frames
const scanWholeFile = fileSize > moviListOffset + moviListSize + 1024;
const scanEnd = scanWholeFile ? fileSize : moviListOffset + moviListSize;
```

#### 6. Chunk Alignment (Word Boundary Padding)
AVI chunks are padded to word (2-byte) boundaries:
```javascript
const paddedSize = (chunkSize + 1) & ~1;
position += chunkHeaderSize + paddedSize;
```

#### 7. RIFF/LIST Headers During Scanning
While scanning for frames, may encounter RIFF/LIST headers:
- These have 12-byte headers (4 FourCC + 4 size + 4 type)
- Skip 12 bytes instead of treating as frame chunk

---

### useFitsParser.js (Future, ~200 lines)

**Planned Responsibilities:**
- Parse FITS header (keyword=value format)
- Extract BAYERPAT keyword for Bayer pattern
- Handle multiple HDUs (Header Data Units)
- Support BITPIX for bit depth detection

---

## Unified Processing: useDebayerReader.js

Main processing module for all formats needing demosaicing.

### Interface

```javascript
const reader = useDebayerReader();

// Initialize with file and parser
await reader.init(file, parser); // parser from useSerParser or useAviParser

// Get metadata
const metadata = reader.getMetadata();
// { width, height, frameCount, bitDepth, bayerPattern, ... }

// Phase 1: Analyze frames (grayscale demosaic, fast)
const analysis = await reader.analyzeFrames({
    maxFrames: 5000,
    stackPercentage: 30,
    surfaceMode: false,
    onProgress: (current, total) => { ... }
});
// Returns: { bestFrames, cropRegion, frameReReader }

// Phase 2: Stack selected frames (VNG demosaic, quality)
const result = await reader.stackFrames({
    frames: analysis.bestFrames,
    drizzleScale: 1.5,
    frameReReader: analysis.frameReReader,
    onProgress: (current, total) => { ... }
});
```

### Two-Phase Processing

#### Phase 1: Analysis & Selection

**Goal:** Quickly analyze all frames to find the best ones for stacking.

**Demosaic Method:** Grayscale-only (NEW optimization)
- Skip full RGB interpolation
- Compute luminance directly from Bayer pattern
- ~2x faster than bilinear color demosaic

**Processing per frame:**
1. Read raw Bayer data from file
2. GPU grayscale demosaic (bilinear, 8-bit output)
3. Compute sharpness (Tenengrad via Laplacian)
4. Detect object bounds (for cropping)
5. Store only metadata: `{ index, sharpness, center, bounds }`

**Memory:** ~10KB per frame (metadata only)

**Preview:** Grayscale preview is acceptable during analysis.
Exception: Bayer pattern selector shows color preview for pattern verification.

#### Phase 2: Stacking

**Goal:** High-quality demosaic and stack selected frames.

**Demosaic Method:** VNG (Variable Number of Gradients)
- 8-directional gradient analysis
- Gradient-weighted interpolation
- Better edge preservation than bilinear

**Processing per frame:**
1. Re-read raw Bayer data (via frameReReader)
2. GPU VNG demosaic → Float32 RGBA (16-bit) or Uint8 RGBA (8-bit)
3. Simultaneously compute packed grayscale (for template matching)
4. Per-frame crop using stored centers
5. Template matching for alignment
6. Accumulate into stack

**Memory:** ~1.6MB per frame (Float32 RGBA for 400x400 crop)

**Pipelining:** Load next batch while GPU processes current batch.

---

## GPU Shaders (webgpu_analyze_worker.js)

### Demosaic Shaders

| Shader | Phase | Method | Output |
|--------|-------|--------|--------|
| `demosaicGrayShader` | 1 | Grayscale-only | Float32 grayscale |
| `demosaicCropShader` | 2 | VNG or bilinear | RGBA + packed grayscale |
| `rgbaCropShader` | 2 | N/A (already RGB) | RGBA + packed grayscale |

### Grayscale Demosaic (Phase 1 Optimization)

For grayscale output, we can simplify demosaicing:
- Luminance = 0.299R + 0.587G + 0.114B
- Green dominates (58.7%), Bayer has 2x green samples
- Can interpolate directly to grayscale without full RGB

```wgsl
// Simplified grayscale demosaic for Phase 1
fn demosaicToGrayscale(x: u32, y: u32) -> f32 {
    let pattern = getBayerPosition(x, y); // R, G, B, or G2

    // Green pixels: use directly (weighted 0.587)
    // Red pixels: interpolate G neighbors, add R contribution
    // Blue pixels: interpolate G neighbors, add B contribution

    // Approximation: Green-heavy weighting
    // This is faster than full RGB → grayscale
}
```

### VNG Demosaic (Phase 2 Quality)

8-directional gradient computation:
```
    N
  NW│NE
W ──┼── E
  SW│SE
    S
```

Algorithm:
1. Compute gradients in 8 directions
2. Threshold = min(gradients) × 1.5 + epsilon
3. Use only directions below threshold
4. Weighted average of neighbor values

---

## Bayer Pattern Reference

### Industry Standard vs OpenCV Naming

OpenCV uses inverted naming (based on 2x2 sub-matrix at row 2, col 2):

| Industry | OpenCV | GPU Index |
|----------|--------|-----------|
| RGGB | BayerBG | 0 |
| BGGR | BayerRG | 1 |
| GRBG | BayerGB | 2 |
| GBRG | BayerGR | 3 |

### Bayer Pattern Layout

```
RGGB:          BGGR:          GRBG:          GBRG:
R G R G        B G B G        G R G R        G B G B
G B G B        G R G R        B G B G        R G R G
R G R G        B G B G        G R G R        G B G B
G B G B        G R G R        B G B G        R G R G
```

---

## Memory Management

### Phase 1 Strategy
- Store only metadata per frame (~10KB)
- Clear frame buffers immediately after analysis
- Keep only: sharpness score, crop center, bounds

### Phase 2 Strategy
- Use `frameReReader` to re-read frames on demand
- Process in batches (default 64 frames)
- Pipeline: load batch N+1 while processing batch N
- Adaptive batch size: reduce on OOM errors

### Two-Pass Architecture Benefits
- Phase 1: 5000 frames × 10KB = 50MB metadata
- Phase 2: 64 frames × 1.6MB = 100MB active
- Without two-pass: 5000 frames × 1.6MB = 8GB (impossible!)

---

## File Structure

```
composables/
├── useDebayerReader.js    # Unified demosaic processing
├── useSerParser.js        # SER format parsing only
├── useAviParser.js        # AVI format parsing only
├── useDirectReader.js     # RGB frames (no demosaic)
├── useFfmpegReader.js     # FFmpeg decode path
├── useStacker.js          # Stacking algorithms
├── useProcessingState.js  # Shared state
└── eventBus.js            # Event communication

public/
├── webgpu_analyze_worker.js    # GPU demosaic & analysis
├── webgpu_stacking.js          # GPU frame accumulation
├── webgpu_template_match.js    # GPU alignment
└── unified_analyze_worker.js   # CPU fallback

(Legacy - to be removed after migration)
├── useSerReader.js        # Old SER reader (3300 lines)
├── useAviReader.js        # Old AVI reader (3400 lines)
└── useImageReader.js      # Old image reader (700 lines)
```

---

## Migration Plan

### Phase A: Create New Modules ✅ COMPLETE
1. ✅ `useSerParser.js` - SER header parsing, bit depth detection, frame count validation, scale factor
2. ✅ `useAviParser.js` - RIFF parsing, frame index scanning, vertical flip, strd Bayer detection
3. ✅ `useDebayerReader.js` - Full unified pipeline with GPU analysis and stacking
4. ✅ Wired parser imports into old readers (backwards compatible)

### Phase B: Wire FileUploader.vue

**Step 1: Route SER files through new reader**

Location: `components/FileUploader.vue` in `processFiles()` function (~line 697)

Current code:
```javascript
if (fileToProcess.name.endsWith('.ser') && !liteMode.value) {
    emit('processing-started');
    const { readSerFile } = useSerReader();
    await readSerFile(fileToProcess, effectiveMaxFrames.value, ...);
    return;
}
```

New code:
```javascript
if (fileToProcess.name.endsWith('.ser') && !liteMode.value) {
    emit('processing-started');
    const { useSerParser } = await import('@/composables/useSerParser');
    const { useDebayerReader } = await import('@/composables/useDebayerReader');

    const parser = useSerParser();
    await parser.init(fileToProcess);

    const reader = useDebayerReader();
    await reader.init(fileToProcess, parser);
    await reader.processFile({
        maxFrames: effectiveMaxFrames.value,
        manualThreshold: effectiveQualityMode.value === 'manual',
        cropMarginPercent: effectiveCropMargin.value,
        stackPercentage: effectiveStackPercentage.value,
        drizzleScale: effectiveDrizzleScale.value,
        noiseRobustAlignment: effectiveNoiseRobust.value,
        surfaceMode: surfaceMode.value,
        useVngDemosaic: useVngDemosaic.value,
    });
    return;
}
```

**Step 2: Route raw 8-bit AVI files through new reader**

Location: `components/FileUploader.vue` (~line 707)

Current code uses `useAviReader().readAviFile()` which internally checks for 8-bit raw and calls `readRawBayerAviFile()`.

New code: Before calling old reader, check if it's 8-bit raw and route to new reader:
```javascript
if (fileToProcess.name.endsWith('.avi') && !liteMode.value) {
    const { checkAviFormat } = useAviReader();
    const formatInfo = await checkAviFormat(headerBuffer, fileToProcess.size);

    // Check if it's 8-bit raw Bayer (needs demosaic)
    if (formatInfo.isSupported && formatInfo.aviHeader.needsDemosaic) {
        emit('processing-started');
        const { useAviParser } = await import('@/composables/useAviParser');
        const { useDebayerReader } = await import('@/composables/useDebayerReader');

        const parser = useAviParser();
        await parser.init(fileToProcess);

        const reader = useDebayerReader();
        await reader.init(fileToProcess, parser);
        await reader.processFile({ ... });
        return;
    }
    // Fall through to old reader for other AVI formats
}
```

**Step 3: Handle multiple SER files**

Location: `components/FileUploader.vue` (~line 671)

Current code: `useSerReader().readSerFiles()` handles multiple SER files.

For now: Keep using old reader for multi-file (can migrate later).

### Phase C: Testing Checklist

1. **SER file - basic**: Load SER, see color selector, analyze, stack, post-process
2. **SER file - 8-bit in 16-bit container**: Verify scale factor detection works
3. **SER file - lying header**: Verify bit depth correction works
4. **SER file - wrong frame count**: Verify frame count validation works
5. **Raw AVI - Y800**: Load Y800 AVI, verify demosaic and stacking
6. **Raw AVI - 8-bit DIB**: Load 8-bit DIB AVI, verify demosaic
7. **Raw AVI - flipped**: Verify vertical flip is applied for bottom-up DIB
8. **Raw AVI - headerless**: Verify frame index scanning works

### Phase D: Cleanup (after testing)

1. Remove debug console.logs from parsers

2. **Dead code in useAviReader.js** - now that 8-bit raw Bayer AVI files route through useDebayerReader:
   - `readRawBayerAviFile()` - entire function is dead (lines ~1880-2280)
   - `createBayerPreviewBlob()` - dead, only used by readRawBayerAviFile
   - `demosaicBayerToRgba()` - dead, duplicated in useDebayerReader.js now
   - `autoStretchRgba()` - dead, duplicated in useDebayerReader.js now
   - `renderAviFrameToBlob()` - dead, defined but never called
   - `detectCropRegionForBayerAvi()` - dead, only used by readRawBayerAviFile
   - The 8-bit raw check inside `readAviFile()` (lines ~867-870) is redundant but harmless as fallback

3. **Dead code in useSerReader.js** - now that SER files route through useDebayerReader:
   - Similar cleanup needed once confirmed working

4. Update CLAUDE.md with new architecture

5. **Sharpness algorithm difference** (document or fix):
   - Old path: bilinear demosaic → RGB → luminance → crop → Tenengrad sharpness
   - New path: raw Bayer value as grayscale (no demosaic) → full-frame Tenengrad with offset
   - Values differ but relative ranking should be similar
   - Consider aligning if users report issues with frame selection

---

## Integration Example

### Using the New Parsers Standalone

```javascript
import { useSerParser } from '@/composables/useSerParser';
import { useAviParser } from '@/composables/useAviParser';
import { useDebayerReader } from '@/composables/useDebayerReader';

// SER file processing
async function processSer(file) {
    const parser = useSerParser();
    await parser.init(file);

    const metadata = parser.getMetadata();
    console.log(`${metadata.width}x${metadata.height}, ${metadata.frameCount} frames`);
    console.log(`Bayer: ${metadata.bayerPattern.opencv}, needs demosaic: ${metadata.needsDemosaic}`);

    // Read a specific frame
    const frameData = await parser.readFrameTyped(0);

    // Or use with unified reader
    const reader = useDebayerReader();
    await reader.init(file, parser);

    const analysis = await reader.analyzeFrames({
        stackPercentage: 30,
        cropMarginPercent: 10,
        onProgress: (current, total) => console.log(`${current}/${total}`)
    });

    console.log(`Best frames: ${analysis.bestFrames.length}`);
}

// AVI file processing
async function processAvi(file) {
    const parser = useAviParser();
    await parser.init(file);

    const metadata = parser.getMetadata();
    console.log(`FourCC: ${metadata.fourCC}, flip needed: ${metadata.needsVerticalFlip}`);

    if (metadata.needsDemosaic) {
        // Use unified debayer reader
        const reader = useDebayerReader();
        await reader.init(file, parser);
        // ... same as SER
    }
}
```

### Integration with FileUploader.vue

The new modules can be integrated incrementally:

1. **Format Detection**: Use parsers for header parsing only
   ```javascript
   import { parseAviHeader } from '@/composables/useAviParser';

   // In checkAviFormat:
   const header = parseAviHeader(buffer, fileSize);
   ```

2. **Parallel Processing**: Run new reader alongside old for comparison
   ```javascript
   // Old path (current)
   const { readSerFile } = useSerReader();
   await readSerFile(file, ...);

   // New path (testing)
   const parser = useSerParser();
   await parser.init(file);
   const reader = useDebayerReader();
   await reader.init(file, parser);
   const analysis = await reader.analyzeFrames({ ... });
   ```

3. **Full Migration**: Replace old reader calls with new unified path

---

## Changelog

- 2024-XX-XX: Initial architecture document
- Added grayscale demosaic for Phase 1 optimization
- Documented AVI edge cases (flip, headerless, strd pattern detection)
- Created useSerParser.js, useAviParser.js, useDebayerReader.js
- Phase A complete - new modules ready for testing
