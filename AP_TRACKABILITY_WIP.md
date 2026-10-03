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

## Added 2026-10-03

Three grid changes modelled on PSS, plus a review step:

1. **Points nudged onto the subject.** A patch more than 60% dark sky moves to
   its own centre of brightness. On a synthetic Jupiter, 42 of 315 moved and all
   42 landed on a brighter pixel. This is why the PSS grid follows the limb
   instead of stopping at a straight lattice edge, and it recovers the limb
   points that the brightness filter used to discard.
2. **Selection is relative, not absolute**: keep points scoring at least 10% of
   the best point in the same image. Across a 9x brightness range the best score
   moved 217 to 41 while the kept count held at 79/86/62. The absolute bar now
   answers only the separate global question, "is anything here trackable at
   all", which a featureless frame fails at 12.2 against 40.
3. **Staggered rows**, offset half a step, as PSS does. Better diagonal sampling
   and it removes the chessboard moire from the overlay for free.

Staggering and nudging together destroy the lattice, so neighbour finding is now
a spatial hash (6 nearest within 1.3x spacing) and spacing is passed through
rather than inferred from point positions. Side effect: the disagreement noise
baseline shifts from ~110% to ~108% with 6 neighbours instead of 4.

Also: a **manual AP checker** option pauses stacking once the grid exists and
draws every patch over the reference frame. The pause resolves on cancel as well
as continue so a cancelled job cannot park on an unsettled promise.

Deliberately NOT done: dropping overlap from 50% toward the PSS 25%. It is a
one-constant change (`AP_SPACING_PATCH_FRACTION`) but it thins the point set,
and thinning measurably costs noise averaging. Needs a measurement first.

## Threshold bugs found by eye, 2026-10-03

Two separate holes in AP coverage, both the same mistake: a threshold that
should not depend on brightness, depending on brightness.

- `minStructure = 0.02` gated on standard deviation against a fixed bar, so a
  dim frame lost points for being dim. Measured on a synthetic planet: 0 points
  rejected at peak 200, 26 at peak 30. Removed. Brightness still gates against
  empty sky; `trackScore` covers structure, relatively and properly.
- `AP_TRACK_RELATIVE = 0.1` did the opposite to bright frames. A bright limb
  lifts the best score, the bar rises with it, mid-disk points fall under:
  35/138 kept and **50% of the disk left bare** at peak 200. Lowered to 0.04,
  matching PSS. Kept count is now flat at 57/138 from peak 200 down to peak 30,
  with 0% bare.

Worth remembering how these were found: both were visible instantly in the AP
checker overlay and invisible in every number the log prints. The coverage test
that initially cleared the grid was measuring the unfiltered lattice, not the
points that survive filtering, so it proved nothing.

## Grid coverage, 2026-10-03 (found via the AP checker overlay)

Three independent edge bugs, none visible in any logged number, all obvious the
moment the grid was drawn over the frame:

1. **The grid stopped short of its own limit.** It stepped by a fixed spacing
   and quit when the next step would overflow, stranding the remainder on one
   side: on a 220px tight crop at patch 56 it reached x=174 where 192 was
   available, leaving 30px bare on the left and 46px on the right. Points are
   now spread evenly across the usable span, landing exactly on the margin at
   both ends. PSS does this too (`ap_locations`, "place boundary neighbors as
   close as possible to the boundary") and it was read without being understood.
2. **Overhanging points were discarded.** Now slid inward instead. On a tight
   crop the rim points cover real signal and a few pixels of displacement costs
   far less than losing them.
3. **Staggered rows were scalloped.** PSS's odd rows are offset half a step AND
   carry one point fewer, so they pull in from both edges: every odd row was
   indented ~21px left and right. Odd rows now keep the stagger in the interior
   but get their two edge points back.

Kept points on a tight crop: 42 -> 114 at patch 28, 23 -> 39 at patch 56.

The remaining bare band is `patchSize/2` and is structural: a patch hanging off
the frame has no pixels to correlate against. PSS reserves more still
(`half_box + search_width`).

## Threshold anchors

Every threshold deciding where APs go is now relative to the image. Three
separate bugs, all the same shape, all found by eye:

| gate | was | now |
|------|-----|-----|
| contrast | `stdDev >= 5/255` | removed; trackScore covers it properly |
| trackability | `>= 40` absolute | `>= 4% of the best in frame` |
| brightness | `mean >= 5` | `>= background + 2% of range` |

Background is the **10th percentile**, not the median. The median only equals
the background when the subject covers less than half the frame, and a tight
planetary crop is the normal case, not the exception. A median-based bar threw
away half a synthetic lunar surface (61 of 138 points) and under-measured a
200px disk as 144px at a 2% crop margin.

Only the global question, "is anything in this frame trackable at all", stays
absolute. That one needs a real-world answer.

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
- **`AP_TRACK_RELATIVE` is anchored to the wrong thing.** It is a fraction of
  the best point in frame, so a high-contrast feature anywhere changes the
  standard everywhere. 0.10 stripped half the disk off bright planets; 0.04
  lets a smooth halo through. The principled anchor is the noise floor: a pure
  noise patch of n pixels scores about `sigma * sqrt(n/2)`, so estimate sigma
  and ask whether a patch is distinguishable from noise. Independent of both
  the brightest pixel and how much of the frame the subject fills, which are
  the two things that broke the previous attempts. NOT BUILT.
- **None of this has been shown to improve a stack.** Everything since the
  trackability work is grid and coverage: better-placed points, verified by
  eye and by synthetic tests. No run has re-measured `disagree`, `capped` or
  the histogram shape on a real capture since. That is the next measurement.
- **All thresholds come from one target.** `AP_TRACK_SCORE_MIN = 40`,
  `AP_TRACK_SHARE_MIN = 0.25`, `AP_MIN_TRACKABLE = 6`.

## Planned UI simplification (agreed 2026-10-03, not built)

Auto sizing becomes the only mode:

- remove the **AP size** number input and the **Auto AP sizing** checkbox from
  the settings panel
- always derive patch size by measurement
- move the override into the **manual AP checker** step instead, so the one
  place you can change AP size is the screen that shows you the grid you are
  changing

Rationale: two controls for the same thing, one of which silently disables the
other, and neither shows the consequence. The checker step does show it. Keep
`showApChecker` as the entry point; the AP size control moves inside it.

## Open question: stretch before AP placement?

The AP checker now stretches the preview for display only. Whether placement
should use a stretched frame is deferred, but the answer is partly known
already: a linear stretch is a uniform scale, so every gradient scales by the
same factor, `trackScore` scales with it, and the RELATIVE selection bar is
completely unaffected. The only thing that would change is the absolute
brightness gate (`mean >= 5`), which would admit points on faint parts of the
subject that it currently drops. So the question reduces to whether that gate
should be relative to the frame's own background, which is the same fix already
applied to the other two thresholds.

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
7. **Build the UI simplification above**: drop the two settings, move AP size
   into the checker step.
8. **Optional: down-weight border-capped shifts** rather than applying them at
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
