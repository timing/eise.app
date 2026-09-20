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
const path = process.argv[2];
if (path) {
    console.log(`\n=== Real file: ${path} ===`);
    try {
        const { default: LibRaw } = await import('libraw-wasm');
        const raw = new LibRaw();
        await raw.open(new Uint8Array(await readFile(path)));
        const meta = await raw.metadata();
        const filters = Number(meta?.filters ?? 0);
        const cd = meta?.color_data?.ColorData || {};
        console.log(`  camera:   ${meta?.camera_make} ${meta?.camera_model}`);
        console.log(`  size:     ${meta?.width}x${meta?.height} (raw ${meta?.raw_width}x${meta?.raw_height})`);
        console.log(`  margins:  top=${meta?.top_margin} left=${meta?.left_margin}`);
        console.log(`  filters:  0x${filters.toString(16)}  colors=${meta?.colors}  cdesc=${meta?.cdesc}`);
        console.log(`  levels:   black=${cd.black} maximum=${cd.maximum}`);
        console.log(`  pattern:  ${bayerPatternFromFilters(filters, Number(meta?.top_margin || 0), Number(meta?.left_margin || 0))}`);
        const r = await raw.rawImageData();
        console.log(`  mosaic:   ${r?.raw_width}x${r?.raw_height} samples=${r?.data?.length} type=${r?.data?.constructor?.name}`);
        raw.dispose?.();
    } catch (e) {
        console.log(`  could not decode here: ${e?.message || e}`);
        console.log('  (libraw-wasm needs a Web Worker; try the file in the app instead)');
    }
}

process.exit(failures === 0 ? 0 : 1);
