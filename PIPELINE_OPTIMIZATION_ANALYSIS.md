# Pipeline Optimization Analysis

Analysis of uncompressed AVI and SER processing pipelines for potential speedups.

## Current Pipeline Architecture

### Frame Processing Flow:
1. **Frame Reading** (AVI/SER file I/O)
2. **Crop Detection** (analyze sample frames for bounds)
3. **Sharpness Analysis** (Tenengrad via CPU workers or GPU)
4. **Bayer Demosaicing** (VNG on GPU or bilinear on CPU)
5. **Frame Selection** (keep top 30% by sharpness)
6. **Alignment** (template matching on GPU)
7. **Stacking** (warp + accumulate on GPU)

---

## Bottlenecks Summary (Updated March 2026)

| Issue | Location | Potential Speedup | Effort | Status |
|-------|----------|-------------------|--------|--------|
| Sequential file I/O | useStacker.js, useDebayerReader.js | **3-4x** for I/O | Low | **DONE** |
| GPU centroid sync | webgpu_analyze_worker.js | **~50ms/batch** | Medium | **DONE** |
| VNG demosaic overhead | gpu/shaders.js | stacking only | High | **LOW PRIORITY** |
| Template matching workgroups | webgpu_template_match.js | **20-30%** | Medium | TODO |
| Packed grayscale unpacking | webgpu_template_match.js | **15-20%** | High | TODO |
| CPU grayscale conversion | useStacker.js | **10-15%** | Medium | TODO |

**Note:** VNG demosaic was marked HIGH PRIORITY but analysis phase already uses `grayOnly` fast path (4 fetches vs 33). VNG only runs during stacking, which is already fast.

**Note:** Line numbers may be outdated due to code refactoring. Use function names to locate code.

---

## Detailed Analysis

### 1. Sequential File I/O - DONE

**Status:** Implemented

**Files changed (note: useSerReader.js is now archived as .old):**
- `useDebayerReader.js` - Parallel batch loading for raw Bayer
- `useStacker.js` - `loadRawBatch()` function (now parallel)
- `useAviReader.js` - Raw Bayer batch loading (now parallel)
- `useAviReader.js` - Crop detection for Bayer AVI (now parallel)
- `useAviReader.js` - MJPEG crop detection batch (now parallel)
- `useFFmpegReader.js` - GPU batch processing with pipelining

**Pattern applied:**
```javascript
// Before: sequential
for (const frame of batchFrames) {
    const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
    frames.push(...);
}

// After: parallel
const frameBuffers = await Promise.all(
    batchFrames.map(frame => {
        const offset = 178 + (frame.index * frameSize);
        return file.slice(offset, offset + frameSize).arrayBuffer();
    })
);
```

**Expected speedup:** 3-4x for I/O-bound operations (large files on SSD)

---

### 1b. GPU Centroid Computation - DONE

**Status:** Implemented

**Problem:**
In `detectCropAnalyzeBatch()`, the pipeline had to wait for bounds data to be read back to CPU
before computing centroids and uploading them for the crop shader. This intermediate sync point
was costing ~50ms per batch (measured as the majority of "prep" time in GPU timing logs).

**Solution:**
Added a GPU compute shader that computes centroids directly on the GPU, eliminating the
intermediate CPU sync. The bounds data is now read back at the END of the pipeline, in parallel
with other readbacks.

**Files changed:**
- `public/webgpu_analyze_worker.js`:
  - Added `centroidShader` (lines 1728-1787): Reduces partial bounds → final bounds + centroids
  - Added `centroidPipeline` creation in `init()` (lines 1925-1929)
  - Added buffers to `getCropAnalyzeBuffers()`:
    - `boundsOutputBuffer` - GPU storage for final bounds
    - `boundsOutputReadback` - MAP_READ buffer for parallel readback
    - `centroidParamsBuffer` - uniform for shader params
  - Modified `detectCropAnalyzeBatch()`:
    - Step 3 now runs centroid compute pass on GPU (lines 3118-3140)
    - Step 6 reads bounds in parallel with other readbacks (line 3240)
    - Bounds/centers arrays built from GPU output after all readbacks (lines 3257-3285)

**Flow before:**
```
boundsReduction → mapAsync(wait) → CPU loop (compute centroids) → writeBuffer(centers) → crop
```

**Flow after:**
```
boundsReduction → centroidCompute → crop → ... → mapAsync(bounds) in parallel with other readbacks
```

**Expected speedup:** ~50ms per batch eliminated from prep time

---

### 2. VNG Demosaic Overhead (LOW PRIORITY - Analysis already optimized)

**Status:** Lower priority than originally thought

**Finding (March 2026):** The analysis phase (the slow part) already uses `grayOnly` mode which bypasses VNG entirely. The `demosaicGrayOnlyShader` averages a 2x2 neighborhood (4 texture fetches) instead of full VNG (~33 fetches).

**VNG is only used during stacking phase** - which is already fast.

**Implementation location:** `public/gpu/shaders.js` - `vngInterpolate()` function

**Problem (stacking only):**
- VNG shader has 8 gradient computations per pixel
- Total: **~33 texture fetches per pixel**
- Compare to grayOnly: only 4 fetches

**If stacking becomes a bottleneck:**

**Option A: Selective VNG** (Low effort)
- Use bilinear for dark background, VNG for bright regions
- Estimated speedup: 25-35% on stacking phase

**Option B: 4-direction VNG** (Medium effort)
- Skip diagonal gradients, slight quality reduction
- Cuts gradient computation in half

**Option C: Shared memory tiling** (High effort)
- Load tile to workgroup shared memory
- Estimated speedup: 40-50%, complex implementation

---

### 3. Template Matching Workgroup Inefficiency (MEDIUM PRIORITY)

**Status:** TODO

**Implementation location:** `public/webgpu_template_match.js`

**Specific code to modify:**
- Lines 265-321: Batch template matching compute shader
- Line 265: `@compute @workgroup_size(256, 1, 1)` - change to 2D

**Changes needed:**
```wgsl
// Before:
@compute @workgroup_size(256, 1, 1)
fn batchTemplateMatch(...) {
    var pos = lid.x;
    while (pos < totalPositions) {
        // ...
        pos += 256u;
    }
}

// After:
@compute @workgroup_size(16, 16, 1)  // 256 threads in 2D grid
fn batchTemplateMatch(...) {
    let localX = lid.x;
    let localY = lid.y;
    let searchWidth = 2 * params.searchRadius + 1;

    // Each thread handles one search position
    let dx = i32(localX) - i32(params.searchRadius);
    let dy = i32(localY) - i32(params.searchRadius);

    // Compute NCC for this position
    let score = computeNCC(apX + dx, apY + dy, ...);

    // Parallel reduction in shared memory
    // ...
}
```

**Also modify:**
- Line 180-195: Dispatch logic to use 2D workgroups
- Shared memory reduction (lines 300-320)

**Expected speedup:** 20-30% on template matching

---

### 4. Packed Grayscale Unpacking in Hot Loop (MEDIUM PRIORITY)

**Status:** TODO

**Implementation location:** `public/webgpu_template_match.js`

**Specific code to modify:**
- Lines 200-212: `sampleFrame()` function in shader
- Lines 150-165: Buffer creation for `frameGraysPacked`

**Changes needed:**

1. Change buffer type (lines 150-165):
```javascript
// Before: packed u32 array
const packedSize = Math.ceil(frameCount * frameSize / 4);
const frameGraysBuffer = device.createBuffer({
    size: packedSize * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
});

// After: linear u8 array (as u32 for WebGPU alignment)
const frameGraysBuffer = device.createBuffer({
    size: frameCount * frameSize,  // No packing
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
});
```

2. Simplify shader sampling (lines 200-212):
```wgsl
// Before:
fn sampleFrame(frameIdx: u32, x: i32, y: i32) -> f32 {
    let pixelIdx = frameIdx * frameSize + u32(y) * params.frameWidth + u32(x);
    let packedIdx = pixelIdx >> 2u;
    let byteOffset = (pixelIdx & 3u) << 3u;
    let packed = frameGraysPacked[packedIdx];
    return f32((packed >> byteOffset) & 0xFFu);
}

// After:
fn sampleFrame(frameIdx: u32, x: i32, y: i32) -> f32 {
    let pixelIdx = frameIdx * frameSize + u32(y) * params.frameWidth + u32(x);
    return f32(frameGrays[pixelIdx]);
}
```

**Memory impact:** +3x for grayscale buffer (temporary, released after matching)

**Expected speedup:** 15-20% on template matching

---

### 5. CPU Grayscale Conversion (MEDIUM PRIORITY)

**Status:** TODO

**Implementation location:** `composables/useStacker.js`

**Specific code to modify:**
- Lines 114-136: `rgbaToGrayscale()` function
- Lines 636-640: Per-frame grayscale conversion call

**Option A: GPU compute pass (recommended)**

Add to `public/webgpu_template_match.js`:
```wgsl
@compute @workgroup_size(256)
fn rgbaToGrayscale(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.pixelCount) { return; }

    let r = rgbaInput[idx * 4];
    let g = rgbaInput[idx * 4 + 1];
    let b = rgbaInput[idx * 4 + 2];

    // Rec. 601 luma
    grayOutput[idx] = u8(0.299 * f32(r) + 0.587 * f32(g) + 0.114 * f32(b));
}
```

Call before template matching instead of CPU loop.

**Option B: Fuse into template matching shader**

Modify `sampleFrame()` to accept RGBA and compute grayscale inline:
```wgsl
fn sampleFrameRgba(frameIdx: u32, x: i32, y: i32) -> f32 {
    let pixelIdx = (frameIdx * frameSize + u32(y) * params.frameWidth + u32(x)) * 4;
    let r = f32(rgbaFrames[pixelIdx]);
    let g = f32(rgbaFrames[pixelIdx + 1]);
    let b = f32(rgbaFrames[pixelIdx + 2]);
    return 0.299 * r + 0.587 * g + 0.114 * b;
}
```

**Expected speedup:** 10-15% overall, eliminates CPU blocking

---

### 6. Redundant 16-bit Data Scaling (LOW PRIORITY)

**Status:** TODO

**Implementation locations:**
- `useSerReader.js` lines 894-901: `scale16bitData()` function
- `public/webgpu_analyze_worker.js` lines 78-93: GPU scale detection

**Changes needed:**
1. Remove CPU-side `scale16bitData()` call for analysis phase
2. Return scale factor from GPU worker in analyze results
3. Cache scale factor per-file, reuse for preview generation

**Expected speedup:** 3-5%

---

### 7. Duplicate Array Wrappers (LOW PRIORITY)

**Status:** TODO

**Implementation location:** `useStacker.js` lines 692-697

**Change:**
```javascript
// Before:
const batchForStacker = gpuResults.map((r, i) => ({
    rgbaBuffer: is16bit
        ? new Float32Array(r.float32Buffer)
        : new Uint8Array(r.uint8Buffer),
    sharpness: batchFrames[i].sharpness
}));

// After: transfer buffers directly without wrapping
const batchForStacker = gpuResults.map((r, i) => ({
    rgbaBuffer: is16bit ? r.float32Buffer : r.uint8Buffer,
    sharpness: batchFrames[i].sharpness
}));
```

**Expected speedup:** 1-2%

---

### 8. Crop Detection Redundancy (LOW PRIORITY)

**Status:** TODO - Architecture changed

**Note:** `useSerReader.js` is now archived. The new architecture uses:
- `useDebayerReader.js` for raw Bayer files
- `useFFmpegReader.js` for video files

**Potential optimization:**
- Crop detection phase samples frames to determine crop SIZE
- Analysis phase detects bounds AGAIN for per-frame CENTER
- Could potentially cache detection results from crop detection phase

**Expected speedup:** 5-10%

---

## What's Already on GPU (Good)

- Bayer demosaicing (VNG)
- Sharpness analysis (Tenengrad)
- Object detection/cropping
- Template matching
- Frame stacking/accumulation

## What's Still on CPU (Consider Moving)

- Grayscale conversion for template matching
- 16-bit data scaling
- Some data format conversions

---

## Recommended Implementation Order

1. ~~**Parallel file loading**~~ - **DONE**
2. **Cache 16-bit scale factor** - Trivial change, 3-5% gain
3. **Eliminate array wrappers** - Quick fix, minor gain
4. **Workgroup size tuning** - Quick experiment, 20-30% gain potential
5. **Fused GPU grayscale** - Medium effort, significant gain
6. **Unpack grayscale storage** - Higher effort, 15-20% gain
7. **Optimize VNG demosaic** - Hardest, biggest potential gain (40-60%)
