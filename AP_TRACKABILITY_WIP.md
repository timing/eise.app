# Alignment point trackability and sizing

Branch: `alignment-point-sizing-and-diagnostics` (commit `0d1800b`, 2026-10-02).
Not merged, not pushed. Auto AP sizing is currently **default on**, which is not
safe to ship yet (see Risks).

## The problem

A soft, dim Jupiter capture stacked badly. Investigation showed the local warp
field was close to noise:

- mean NCC **0.98**, with **0.0% dropped** at AP quality thresholds 0.3, 0.55 and 0.7
- neighbouring APs, overlapping by half their pixels, disagreed about the
  displacement by **93% of the warp magnitude** (uncorrelated noise reads ~110%)
- the applied-displacement histogram was only ~1.5x better than a uniformly
  random argmax over the search window
- 25% of shifts were pinned to the search-window border

## Root cause

`filterAPsByQuality` selected alignment points on standard deviation, which
measures **contrast**, not **localizability**.

A smooth limb-darkened disk has plenty of contrast but correlates with itself at
every offset, so its NCC surface is a shallow plateau rather than a peak. NCC
therefore scores *highest* exactly where the match is *least* trustworthy, which
is why no quality threshold could ever help. All 120 selected points on that file
were untrackable, and all 120 were used.

The quantity that does separate the cases is the smaller eigenvalue of the
patch's structure tensor (Shi-Tomasi). Specifically **total** structure,
`trackScore = sqrt(lambda_min)`, not per-pixel gradient:

| patch | weakGrad (per-pixel) | trackScore (total) | neighbour disagreement |
|-------|----------------------|--------------------|------------------------|
| 30px  | 0.53                 | 14.8               | 93% (noise)            |
| 64px  | 0.55                 | 34.1               | 55%                    |
| 84px  | 0.56                 | 45.9               | 41% (real seeing)      |

Per-pixel gradient barely moves while quality transforms. A larger patch
accumulates more of the same gentle gradient, and that is what pins the match
down. `AP_TRACK_SCORE_MIN` is set to 40, just below where the field became real.

## What is on the branch

1. **Trackability gate** in `filterAPsByQuality`, on `trackScore`. Rejects a bad
   AP once at build time instead of once per frame.
2. **Measured auto patch sizing** (`chooseAutoPatchSize`). Tries candidate sizes
   and keeps the smallest that yields trackable points. Two synthetic 210px
   targets pick 20px (sharp) and 56px (soft), so it is driven by detail, not size.
3. **Global-alignment fallback** (`assessLocalWarp`). Too few trackable points
   means no local warp rather than applying noise. Threshold is relative to grid
   size; an absolute floor broke a 48px crop (see below).
4. **Spacing caps overlap at 50%**, as a floor on the existing frame-size rule, so
   every current configuration keeps its exact spacing and only large patches move.
5. **Warp readout in the log** (see "Reading the log").

Search radius is deliberately left at the existing defaults, 8 planetary and 34
surface. See Risks.

## Reading the log

```
─── Warp @ APs ───
306,000 meas (1500f x 204/225ap kept (91%)), 15x15 grid, patch 84px, spacing 20px, overlap 76%, span 280x280px, radius 14px
NCC 0.99, dropped<0.55 0.0%
ridge 0.0%, noise-limited 100.0%, weakGrad 0.56/px (204ap) | img 0-82/255, mean 32.7, sd 26.3
applied 306,000, mean 3.44px, vector (-0.79, -1.00), capped 0.1%
disagree 1.42px = 41.1% (0 smooth / 110 noise)
 0px |████ 2.1% (6,273)
```

- **disagree** is the headline. 0% = neighbours move together, under 50% = real
  seeing, ~110% = independent noise. Only comparable between runs at the same
  **overlap**.
- **capped** = NCC peak sat on the window border, so the value is a cap rather
  than a measurement. The stacker applies these at full weight (see Risks).
- **histogram shape** matters more than the mean. A Rayleigh-looking hump is real
  seeing; a roughly linear rise to the window edge is a wandering argmax.
- **weakGrad** is per-pixel and does not predict quality on its own. Multiply by
  patch size for the number that does.

Validated against synthetic fields: smooth warp reads 8%, large translation plus
noise 10%, uncorrelated noise 110%.

## Risks and known-broken

- **Auto AP sizing is default on.** It has already failed once, on a 48px crop,
  producing a near-black stack. Everything here was calibrated on a 384px frame
  plus synthetics. **Default it off until the small-crop regime is covered.**
- **UNVERIFIED: the bundled sample clip stacked visibly wobbly on this branch.**
  Jupiter came out non-round where prod renders it round, on the clip every new
  user stacks first, so this is a user-facing regression and not a curiosity.
  Diagnosis was a `D/15` search-radius rule: the frame is uncropped and contains
  a moon, so the area-based diameter inflated past 503px, hit the 34px ceiling
  and handed the matcher a window it promptly filled with 20px of random wander
  (`mean 20.57px`, `disagree 70.3%`, `capped 10.7%`). The rule is reverted to the
  8/34 defaults, which should bound wander at 8px, **but the clip was never
  re-stacked after the revert**. Re-run it and confirm round before trusting any
  of this. If it is still wobbly, the next suspect is the trackability gate
  thinning APs (see noise averaging below), which on that same clip kept only
  972 of 3311.
- **Search radius must not be derived from the measured subject.** Two real
  captures regressed when it was. Keep it at the 8/34 defaults and let the
  `capped` readout say when a specific file needs more.
- **`measureTargetDiameter` sums total lit area**, so it does not isolate the
  largest object and is unreliable with more than one subject (Jupiter plus a
  moon) or with bright background. It now only caps patch size, where an
  overestimate is mostly harmless, but the `target Npx` readout is not trustworthy.
- **The trackability gate can cost noise averaging.** On the wobbly sample clip
  above it kept 972 of 3311 APs. The warp at each pixel is a Gaussian average over APs within
  `patchSize * 4`, so thinning the set by ~3.4x raises field noise by roughly
  sqrt of that, ~1.9x. Filtering helps when bad APs are *biased* and hurts when
  they are merely *noisy*. This trade-off is untested.
- **Border-capped shifts are applied at full weight.** The warp shader has no
  notion of the search radius, so a capped value carries the same weight as a
  measurement.
- **All thresholds come from one target.** `AP_TRACK_SCORE_MIN = 40`,
  `AP_TRACK_SHARE_MIN = 0.25`, `AP_MIN_TRACKABLE = 6`.

## Next steps, in order

0. **Re-stack the bundled sample clip and confirm Jupiter is round.** It was
   visibly wobbly on this branch and the fix is unverified. Nothing else here
   matters until that is known, because it is the first file every new user
   stacks. Compare `disagree` and `capped` against the pre-revert numbers
   (`mean 20.57px`, `disagree 70.3%`, `capped 10.7%`).
1. **Default auto AP sizing off.** One line. Do this before anything else goes to
   prod.
2. **Quality-based fallback.** The current fallback counts APs, which cannot
   catch the wobbled clip: 972 APs sails past any count threshold while being 70%
   noise. Compute `disagree` after the first batch of template matching, before
   accumulating it, and disable local warp for the run above ~65%. This is the
   check that would have saved that file.
3. **Largest-blob diameter.** Flood fill the thresholded mask and keep the biggest
   connected component, so Jupiter is measured and Ganymede and haze are not.
   Makes the `target Npx` readout honest.
4. **Cover the small-crop regime.** Crops in the 32-100px range, where patch size
   is capped by `floor(minDim/3)` and the whole grid may be under 20 points.
   Re-check `AP_MIN_TRACKABLE`, the candidate list floor and the spacing guard.
5. **Recalibrate `AP_TRACK_SCORE_MIN` on more than one target.** Needs a few
   captures spanning sharp/soft and large/small, scored by `disagree` at matched
   `overlap`.
6. **Decide the filtering trade-off.** Measure whether gating APs helps or hurts
   on a clip where matches are noisy but unbiased. If it hurts, gate it behind
   auto so manual settings reproduce prod exactly.
7. **Optional: down-weight border-capped shifts** rather than applying them at
   full weight. Low urgency while the radius stays at its defaults.

## Cost

NCC work scales as `APs x (2r+1)^2 x patchSize^2`. Patch size and radius both
enter quadratically, so auto sizing can be expensive. Measured on the 384px
Jupiter:

| config | APs | work | vs baseline |
|--------|-----|------|-------------|
| patch 30, r8 | 120 | 31M | 1.0x |
| patch 64, r8 | 198 | 234M | 7.5x |
| patch 84, r14 (spacing 20) | 204 | 1211M | 38.8x |
| patch 80, r17 (spacing 40) | ~56 | 439M | 14x |

The spacing fix is what makes large patches affordable. Keep an eye on this given
the mobile NCC watchdog work.
