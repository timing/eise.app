/**
 * libRawCfa.js - pure CFA-pattern maths for LibRaw's `filters` bitmask.
 *
 * Deliberately dependency-free (no Vue, no Sentry, no SER constants) so the
 * same code runs inside the app and in `scripts/libraw-probe.mjs` under plain
 * Node. The SER colour-id mapping lives in useLibRawParser.js, which owns the
 * SER constants; this module only names the pattern.
 */

// LibRaw sentinel values for imgdata.idata.filters.
export const FILTERS_NONE = 0;    // full-colour: linear DNG, Foveon, already demosaiced
export const FILTERS_XTRANS = 9;  // Fuji 6x6 X-Trans mosaic

/**
 * LibRaw's FC(): which colour sits at (row, col) of the raw mosaic.
 * 0=R, 1=G, 2=B, 3=G2. Port of the macro in libraw_types.h.
 */
export function fc(filters, row, col) {
    return (filters >>> ((((row << 1) & 14) + (col & 1)) << 1)) & 3;
}

/**
 * Bayer phase at the VISIBLE top-left, not the raw top-left. The masked border
 * LibRaw reports via top_margin/left_margin is often an odd number of pixels,
 * which shifts the pattern; reading the phase at (0,0) instead would silently
 * swap red and blue on those cameras.
 *
 * Returns 'RGGB' | 'GRBG' | 'GBRG' | 'BGGR', or null if the layout is not a
 * 2x2 Bayer grid.
 */
export function bayerPatternFromFilters(filters, topMargin = 0, leftMargin = 0) {
    if (!filters || filters === FILTERS_XTRANS) return null;

    const c00 = fc(filters, topMargin, leftMargin);
    const c01 = fc(filters, topMargin, leftMargin + 1);
    const c10 = fc(filters, topMargin + 1, leftMargin);
    const isGreen = (c) => c === 1 || c === 3;

    if (c00 === 0 && isGreen(c01)) return 'RGGB';
    if (c00 === 2 && isGreen(c01)) return 'BGGR';
    if (isGreen(c00) && c01 === 0) return 'GRBG';
    if (isGreen(c00) && c01 === 2) return 'GBRG';
    // Ambiguous horizontally (both greens): fall back to the vertical neighbour.
    if (isGreen(c00) && c10 === 0) return 'GBRG';
    if (isGreen(c00) && c10 === 2) return 'GRBG';
    return null;
}
