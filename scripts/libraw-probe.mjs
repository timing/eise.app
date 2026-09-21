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
            const mosaic = r ? { raw_width: r.raw_width, raw_height: r.raw_height, samples: r.data?.length, type: r.data?.constructor?.name } : null;
            raw.dispose?.();
            return { meta, mosaic, histo };
        }, b64);

        report(out.meta, out.mosaic, out.histo);
    } catch (e) {
        console.log(`  could not decode: ${e?.message || e}`);
        console.log(`  (needs the dev server on ${devUrl} and playwright; set EISE_DEV_URL to change)`);
    } finally {
        await browser?.close();
    }
}

process.exit(failures === 0 ? 0 : 1);
