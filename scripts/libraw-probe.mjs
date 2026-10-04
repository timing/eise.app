// Verify the LibRaw CFA maths, and optionally probe a real RAW file.
//
// Part 1 always runs: asserts bayerPatternFromFilters() against the four
// canonical dcraw/LibRaw `filters` constants. Pure arithmetic, no wasm, so it
// is safe to run anywhere and catches a red/blue swap before it reaches a user.
//
// Part 2 runs when given a file path: loads libraw-wasm and prints the real
// metadata (filters, margins, levels) plus the pattern we derive from it.
// libraw-wasm drives a Web Worker, so this half may not run under plain Node;
// if it does not, open the file in the app instead.
//
// Usage:
//   node scripts/libraw-probe.mjs                 # maths only
//   node scripts/libraw-probe.mjs /path/shot.CR2  # maths + real file
import { readFile } from 'node:fs/promises';
import { bayerPatternFromFilters, fc, FILTERS_XTRANS } from '../composables/libRawCfa.js';

// dcraw/LibRaw encode the mosaic as a repeating 2-bit-per-pixel bitmask. These
// four values are what identify() writes for the standard Bayer layouts.
const CANONICAL = [
    { filters: 0x94949494, expect: 'RGGB' },
    { filters: 0x61616161, expect: 'GRBG' },
    { filters: 0x49494949, expect: 'GBRG' },
    { filters: 0x16161616, expect: 'BGGR' },
];

let failures = 0;
function check(label, actual, expected) {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(44)} got=${actual} want=${expected}`);
}

console.log('\n=== CFA pattern maths (no margins) ===');
for (const { filters, expect } of CANONICAL) {
    check(`filters=0x${filters.toString(16)}`, bayerPatternFromFilters(filters, 0, 0), expect);
}

console.log('\n=== Every 2x2 has exactly one R, one B, two G ===');
for (const { filters, expect } of CANONICAL) {
    const cells = [fc(filters, 0, 0), fc(filters, 0, 1), fc(filters, 1, 0), fc(filters, 1, 1)];
    const reds = cells.filter(c => c === 0).length;
    const blues = cells.filter(c => c === 2).length;
    const greens = cells.filter(c => c === 1 || c === 3).length;
    check(`${expect} channel census`, `${reds}R${greens}G${blues}B`, '1R2G1B');
}

// An odd margin shifts the phase by one pixel in each axis, which turns RGGB
// into BGGR. This is the case that silently swaps red and blue if we read the
// pattern at the raw origin instead of the visible one.
console.log('\n=== Odd margins shift the phase ===');
check('RGGB + (1,1) margin', bayerPatternFromFilters(0x94949494, 1, 1), 'BGGR');
check('RGGB + (0,1) margin', bayerPatternFromFilters(0x94949494, 0, 1), 'GRBG');
check('RGGB + (1,0) margin', bayerPatternFromFilters(0x94949494, 1, 0), 'GBRG');
check('RGGB + (2,2) margin', bayerPatternFromFilters(0x94949494, 2, 2), 'RGGB');

console.log('\n=== Non-Bayer layouts report null ===');
check('X-Trans', String(bayerPatternFromFilters(FILTERS_XTRANS, 0, 0)), 'null');
check('no CFA', String(bayerPatternFromFilters(0, 0, 0)), 'null');

console.log(`\n${failures === 0 ? 'All maths checks passed.' : `${failures} CHECK(S) FAILED.`}`);

// ---------------------------------------------------------------------------
// Part 2. libraw-wasm drives a Web Worker, which plain Node does not provide,
// so decoding runs in headless Chromium against the dev server instead. That
// also means we exercise the very same /libraw/ files the browser loads.
const path = process.argv[2];

// Is what rawImageData() hands back the real undebayered sensor mosaic, or an
// already-developed image (an embedded preview, or a demosaic LibRaw did for
// us)? Two independent signals, both computed over the brightest region so a
// dark sky cannot wash them out:
//
//  1. Per-CFA-phase means. Raw Bayer carries no white balance, and green sits
//     well above red and blue on every consumer sensor, so the four phases
//     must differ clearly. A developed image has them roughly equal.
//  2. Checkerboard contrast. In a mosaic, horizontal neighbours are different
//     colours and differ a lot; samples two apart are the same colour and
//     differ little. A developed image has no such alternation, so the ratio
//     sits near 1.
function reportPhases(ph) {
    if (!ph) return;
    console.log(`\n  --- mosaic vs developed image (brightest ${ph.tile}x${ph.tile} tile at ${ph.tx},${ph.ty}) ---`);
    const names = ['(even x, even y)', '(odd x,  even y)', '(even x, odd y)', '(odd x,  odd y)'];
    const means = ph.phaseMeans;
    for (let i = 0; i < 4; i++) {
        console.log(`  phase ${i} ${names[i]}: mean ${means[i].toFixed(1)}  ${ph.phaseLabels[i]}`);
    }
    const spread = (Math.max(...means) - Math.min(...means)) / (means.reduce((s, v) => s + v, 0) / 4);
    console.log(`  phase spread:      ${(100 * spread).toFixed(1)}% of mean   (mosaic: tens of %, developed: ~0%)`);
    console.log(`  checkerboard:      adjacent |d|=${ph.adjDiff.toFixed(1)}  same-phase |d|=${ph.sameDiff.toFixed(1)}  ratio=${(ph.adjDiff / (ph.sameDiff || 1)).toFixed(2)}`);
    console.log(`  zero samples:      ${ph.zeros}/${ph.total} of the whole visible frame (${(100 * ph.zeros / ph.total).toFixed(3)}%)`);
    const isMosaic = spread > 0.12 && ph.adjDiff > 1.5 * ph.sameDiff;
    console.log(`\n  VERDICT: ${isMosaic ? 'undebayered Bayer mosaic (real sensor data)' : 'looks DEVELOPED/flat, not a raw mosaic'}`);
}

// What colour does this bright region actually come out as, at each stage of
// the development LibRaw performs? We apply the white balance but not the
// camera->sRGB matrix, so this shows whether the cast we produce is supposed
// to survive that matrix or be removed by it.
function reportColour(ph, meta, blackGuess) {
    if (!ph?.rgb) return;
    const cd = meta?.color_data?.ColorData || meta?.color_data || {};
    const mul = [].concat(cd.cam_mul || []).map(Number);
    const mat = cd.rgb_cam || cd.cmatrix;
    const show = (label, c) => {
        const g = c[1] || 1;
        console.log(`  ${label.padEnd(28)} R ${c[0].toFixed(0).padStart(6)}  G ${c[1].toFixed(0).padStart(6)}  B ${c[2].toFixed(0).padStart(6)}   ratio to G: ${(c[0] / g).toFixed(2)} / 1.00 / ${(c[2] / g).toFixed(2)}`);
    };

    console.log(`\n  --- colour of that tile through the development chain (black ${blackGuess}) ---`);
    const raw = ph.rgb.map((v) => Math.max(0, v - blackGuess));
    show('raw mosaic (no WB)', raw);

    if (!(mul.length >= 3 && mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) {
        console.log('  cam_mul unusable; cannot model white balance.');
        return;
    }
    const wb = [raw[0] * mul[0], raw[1] * mul[1], raw[2] * mul[2]];
    const norm = wb[1] / raw[1];
    show('+ camera WB (what we do)', wb.map((v) => v / norm));

    if (!Array.isArray(mat) || mat.length < 3) {
        console.log('  no rgb_cam matrix reported; cannot model the camera->sRGB step.');
        return;
    }
    const m = mat.slice(0, 3).map((r) => [].concat(r).map(Number));
    const out = [0, 1, 2].map((i) => m[i][0] * wb[0] + m[i][1] * wb[1] + m[i][2] * wb[2]);
    show('+ rgb_cam (what LibRaw does)', out.map((v) => v / norm));
    console.log('  If the last row is near-neutral and the middle one is not, the cast is the');
    console.log('  missing colour matrix, not the white balance and not the Bayer pattern.');
}

function report(meta, mosaic, histo) {
    const filters = Number(meta?.filters ?? 0);
    const cd = meta?.color_data?.ColorData || meta?.color_data || {};
    const top = Number(meta?.top_margin || 0);
    const left = Number(meta?.left_margin || 0);
    console.log(`  camera:   ${meta?.camera_make} ${meta?.camera_model}`);
    console.log(`  size:     ${meta?.width}x${meta?.height} (raw ${meta?.raw_width}x${meta?.raw_height})`);
    console.log(`  margins:  top=${top} left=${left}`);
    console.log(`  filters:  0x${filters.toString(16)}  colors=${meta?.colors}  cdesc=${meta?.cdesc}`);
    console.log(`  levels:   black=${cd.black} maximum=${cd.maximum}`);
    if (cd.cam_mul) console.log(`  cam_mul:  [${[].concat(cd.cam_mul).join(', ')}]`);
    if (cd.pre_mul) console.log(`  pre_mul:  [${[].concat(cd.pre_mul).join(', ')}]`);
    if (Array.isArray(cd.cblack)) console.log(`  cblack:   [${cd.cblack.slice(0, 8).join(', ')}]`);
    const mat = cd.rgb_cam || cd.cmatrix;
    if (Array.isArray(mat)) {
        console.log(`  rgb_cam:  ${mat.map(r => `[${[].concat(r).map(v => Number(v).toFixed(3)).join(', ')}]`).join(' ')}`);
    }
    console.log(`  pattern:  ${bayerPatternFromFilters(filters, top, left)}`);
    if (mosaic) console.log(`  mosaic:   ${mosaic.raw_width}x${mosaic.raw_height} samples=${mosaic.samples} type=${mosaic.type}`);

    if (histo) {
        // What the normalisation in useLibRawParser.js actually does to this
        // data: scaleFactor = 65535 / (maximum - black). If the sky background
        // lands high after that, the stack is bright before any stretch.
        const black = Number(cd.black ?? 0);
        const maximum = Number(cd.maximum ?? 0);
        const scale = maximum > black ? 65535 / (maximum - black) : 1;
        console.log(`\n  --- raw mosaic levels (visible area) ---`);
        console.log(`  min=${histo.min} p1=${histo.p1} median=${histo.median} p99=${histo.p99} max=${histo.max} mean=${histo.mean.toFixed(1)}`);
        console.log(`  saturated (>=maximum): ${(100 * histo.atMax / histo.n).toFixed(3)}%`);
        console.log(`\n  --- after black-subtract + scaleFactor ${scale.toFixed(3)} ---`);
        const norm = (v) => Math.round(Math.max(0, v - black) * scale);
        console.log(`  median ${histo.median} -> ${norm(histo.median)}  (${(100 * norm(histo.median) / 65535).toFixed(1)}% of full scale)`);
        console.log(`  p99    ${histo.p99} -> ${norm(histo.p99)}  (${(100 * norm(histo.p99) / 65535).toFixed(1)}%)`);
        console.log(`  max    ${histo.max} -> ${norm(histo.max)}`);
    }
}

if (path) {
    console.log(`\n=== Real file: ${path} ===`);
    const devUrl = process.env.EISE_DEV_URL || 'http://localhost:3000';
    let browser;
    try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto(`${devUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Hand the file over as base64. A plain number[] would be one JS array
        // element per byte across the CDP bridge, which blows Node's heap on a
        // 24MB raw long before the decoder ever sees it.
        const b64 = (await readFile(path)).toString('base64');
        const out = await page.evaluate(async (b64In) => {
            const bin = atob(b64In);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const { default: LibRaw } = await import('/libraw/index.js');
            const raw = new LibRaw();
            await raw.open(buf);
            // Must match what useLibRawParser does: the short payload omits
            // filters, colors and the levels.
            const meta = await raw.metadata(true);
            const r = await raw.rawImageData();

            // Sample the visible area only. The masked border LibRaw includes
            // is the black-calibration region and would skew every statistic.
            let histo = null;
            if (r?.data) {
                const rw = r.raw_width, top = Number(meta?.top_margin || 0), left = Number(meta?.left_margin || 0);
                const vw = Number(meta?.width || 0), vh = Number(meta?.height || 0);
                const vals = [];
                const step = Math.max(1, Math.floor(Math.sqrt((vw * vh) / 400000)));
                let atMax = 0;
                const maximum = Number(meta?.color_data?.ColorData?.maximum ?? meta?.color_data?.maximum ?? 0);
                for (let y = 0; y < vh; y += step) {
                    for (let x = 0; x < vw; x += step) {
                        const v = r.data[(y + top) * rw + (x + left)];
                        vals.push(v);
                        if (maximum && v >= maximum) atMax++;
                    }
                }
                vals.sort((a, b) => a - b);
                const n = vals.length;
                histo = {
                    n, atMax, min: vals[0], max: vals[n - 1],
                    p1: vals[(n * 0.01) | 0], median: vals[n >> 1], p99: vals[(n * 0.99) | 0],
                    mean: vals.reduce((s, v) => s + v, 0) / n,
                };
            }
            // Mosaic-vs-developed test. Find the brightest tile first: the
            // phase means only separate where there is signal, and most of an
            // astro frame is sky.
            let phases = null;
            if (r?.data) {
                const rw = r.raw_width, top = Number(meta?.top_margin || 0), left = Number(meta?.left_margin || 0);
                const vw = Number(meta?.width || 0), vh = Number(meta?.height || 0);
                const TILE = 128;
                let best = -1, tx = 0, ty = 0;
                for (let y0 = 0; y0 + TILE <= vh; y0 += TILE) {
                    for (let x0 = 0; x0 + TILE <= vw; x0 += TILE) {
                        let s = 0;
                        for (let y = y0; y < y0 + TILE; y += 4) {
                            const row = (y + top) * rw + left;
                            for (let x = x0; x < x0 + TILE; x += 4) s += r.data[row + x];
                        }
                        if (s > best) { best = s; tx = x0; ty = y0; }
                    }
                }

                // Phase index is (x&1) + 2*(y&1) relative to the VISIBLE
                // origin, which is the phase the rest of the app works in.
                const sums = [0, 0, 0, 0], counts = [0, 0, 0, 0];
                let adjDiff = 0, sameDiff = 0, pairs = 0;
                for (let y = ty; y < ty + TILE; y++) {
                    const row = (y + top) * rw + left;
                    for (let x = tx; x < tx + TILE; x++) {
                        const v = r.data[row + x];
                        const p = (x & 1) + 2 * (y & 1);
                        sums[p] += v; counts[p]++;
                        if (x < tx + TILE - 2) {
                            adjDiff += Math.abs(v - r.data[row + x + 1]);
                            sameDiff += Math.abs(v - r.data[row + x + 2]);
                            pairs++;
                        }
                    }
                }

                // Zero count over the whole visible frame: "is it pure black?"
                // answered directly rather than inferred from a histogram.
                let zeros = 0, total = 0;
                const zstep = Math.max(1, Math.floor(Math.sqrt((vw * vh) / 1000000)));
                for (let y = 0; y < vh; y += zstep) {
                    const row = (y + top) * rw + left;
                    for (let x = 0; x < vw; x += zstep) { if (r.data[row + x] === 0) zeros++; total++; }
                }

                phases = {
                    tile: TILE, tx, ty, zeros, total,
                    phaseMeans: sums.map((s, i) => s / (counts[i] || 1)),
                    adjDiff: adjDiff / (pairs || 1),
                    sameDiff: sameDiff / (pairs || 1),
                };
            }

            const mosaic = r ? { raw_width: r.raw_width, raw_height: r.raw_height, samples: r.data?.length, type: r.data?.constructor?.name } : null;
            raw.dispose?.();
            return { meta, mosaic, histo, phases };
        }, b64);

        report(out.meta, out.mosaic, out.histo);

        if (out.phases) {
            // Label each phase with the colour the CFA says it carries, so a
            // green-highest reading can be confirmed against the pattern
            // rather than assumed.
            const filters = Number(out.meta?.filters ?? 0);
            const top = Number(out.meta?.top_margin || 0), left = Number(out.meta?.left_margin || 0);
            const COLOURS = ['R', 'G', 'B', 'G'];
            out.phases.phaseLabels = [0, 1, 2, 3].map((p) => {
                const dx = p & 1, dy = p >> 1;
                return COLOURS[fc(filters, top + dy, left + dx)];
            });
            // Collapse the four phases into R, G, B for the colour model.
            const means = out.phases.phaseMeans;
            let r = 0, b = 0, gSum = 0, gN = 0;
            out.phases.phaseLabels.forEach((lab, p) => {
                if (lab === 'R') r = means[p];
                else if (lab === 'B') b = means[p];
                else { gSum += means[p]; gN++; }
            });
            out.phases.rgb = [r, gN ? gSum / gN : 0, b];

            reportPhases(out.phases);
            reportColour(out.phases, out.meta, out.histo?.p1 ?? 0);
        }
    } catch (e) {
        console.log(`  could not decode: ${e?.message || e}`);
        console.log(`  (needs the dev server on ${devUrl} and playwright; set EISE_DEV_URL to change)`);
    } finally {
        await browser?.close();
    }
}

process.exit(failures === 0 ? 0 : 1);
