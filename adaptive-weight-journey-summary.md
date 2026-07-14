# Adaptive Weight Journey — App Summary

A single-file HTML/CSS/JS web app (no build step, no backend) that turns a weight goal into a personalized, self-adjusting calorie roadmap. Supports loss, gain, and maintenance. Mobile-first, ~480px max width, bottom tab navigation.

## Core concept
User enters body stats (weight, height, age, sex, activity level) and a goal. The app estimates real energy needs via BMR/TDEE, then breaks the weight range into "phases" at a fixed interval (e.g. every 5 lbs). Each phase has its own maintenance and eating calorie target. As the user's *rolling average* weight crosses a phase's target, the calorie target automatically steps to the next phase. Over time, the app also compares actual logged results against the formula estimate and self-corrects.

## Calorie engine
- **BMR**: Mifflin-St Jeor formula (`calcBMR`) — `10×kg + 6.25×cm − 5×age (+5 male / −161 female)`.
- **TDEE**: `calcTDEE` = BMR × activity multiplier (sedentary 1.20 / light 1.375 / moderate 1.55 / veryActive 1.725).
- **Phase calories are recalculated fresh at each phase's target weight** (`tdeeAtWeight`), not scaled proportionally from the starting TDEE — proportional scaling was a bug (it scaled the whole TDEE including the weight-independent BMR terms, understating calories at lower weights by 300+ cal in a typical 90 lb journey). Fixed.
- **Goal types**: loss (`maintenance − deficit`), gain (`maintenance + surplus`), maintain (`= maintenance`).
- **Legacy fallback**: profiles without body stats (`height`/`age`/`sex`/`activityLevel`) fall back to `weightTarget × multiplier`, preserving pre-upgrade behavior.
- **Manual override**: `calcMode: 'multiplier'` lets advanced users force the flat multiplier formula even with body stats present.

## Metabolic calibration (`computeCalibration`)
Compares actual logged calories eaten vs. actual weight trend over a 28-day window (needs ≥10 food logs and ≥4 weigh-ins in that window) to derive the user's *real* TDEE via energy balance (`actualTDEE = avgCaloriesEaten − weightChangeSlope×3500`). The ratio of actual-to-formula TDEE becomes a calibration factor (clamped to ±25%) applied multiplicatively to all future phase calorie calculations. Purely derived live from logs each render — nothing persisted, so it's never stale. Surfaced on the dashboard, the calc-details page, and the Roadmap tab.

## Deficit tapering (optional, `profile.taperDeficit`)
Gradually eases the deficit/surplus by up to 40% over the final third of the journey (by weight distance, not time), matching common coaching guidance to protect muscle as body fat gets lower. Off by default.

## Rolling average gating
Weight fluctuates day to day, so phase advancement is NOT driven by the single latest scale reading:
- `rollingAverageWeight(n=5)`: averages the last 5 logged weigh-ins.
- All phase-progression logic — active phase, "goal reached," calorie target, roadmap badges — is direction-aware (`phaseDirection`) and driven off this rolling average, so it works symmetrically for loss (descending phases) and gain (ascending phases).
- The raw latest weight is still shown separately on the dashboard ("Current weight") alongside the rolling average.

## Completion estimate (`estimateCompletion`)
Projects a recent-window (21-day, min 4 points) linear regression forward to estimate a "next phase" date and a "goal weight" date. The near-term phase estimate shows readily; the far-out goal-date estimate is gated by two checks — minimum 21 days of tracking history, and the projection can't exceed 6× the days actually tracked — to avoid a noisy 2-week trend producing a falsely precise date 6+ months out. Shows "insufficient data" or "stalled" (wrong-direction trend) fallback messages otherwise.

## Data model (stored client-side only)
```js
state = {
  profile: {
    name, startWeight, goalWeight, height, age, sex, activityLevel, goalType,
    multiplier, recommendedMultiplier, bmr, tdee,
    calcMode, deficit, interval, taperDeficit, createdDate
  },
  weightLogs: [{ id, date, weight, notes }],
  nutritionLogs: [{ id, date, meals: [{ id, label, calories }], protein, carbs, fat, water }]
}
```
- `weightLogs` and `nutritionLogs` remain separate arrays (one entry per date per type), but the UI presents them merged as a single daily "activity" — see Log tab below. They're joined purely by matching `date` strings; there's no shared id between a day's weight entry and its nutrition entry.
- **Calories are itemized, not a single number**: each `nutritionLogs` entry holds a `meals` array, each item with its own `calories` and a `label` constrained to a fixed set: `MEAL_CATEGORIES = ['Breakfast','Lunch','Dinner','Snack','Drinks','Other']` (picked via dropdown, not free text — needed for the category chart to have stable, groupable buckets). The displayed/used total is always `nutritionTotalCalories(n)` — the live sum of `meals[].calories` — never a stored total, so it can't drift out of sync.
- **Legacy migration**: older entries saved before the itemized-meals upgrade had a flat `calories` number and no `meals` array; entries from before the fixed-category dropdown had free-text (often blank) labels. `migrateNutritionLogs()` runs on every load (and on import) and backfills both: missing `meals` arrays become a single `Other`-labeled item, and any label not in `MEAL_CATEGORIES` is coerced to `Other`. So old data displays and sums (and buckets into the donut chart) correctly with no user action.
- Persisted via `localStorage` (key `awj:data`) — local to the browser/origin, no server, no auth, no cross-device sync.
- **Export/Import**: Settings has an "Export data" button (downloads a timestamped JSON file, itemized meals included as-is) and "Import data" (file picker, validates shape, runs the same legacy-meals migration, confirms before overwriting) — the only backup/portability mechanism. Verified round-trip-safe for both current-format and pre-upgrade legacy exports.
- One entry per date per log type (saving on a date that already has an entry overwrites it).
- **Outlier guard**: saving a weigh-in that's an implausible jump from the last entry (threshold scales with days-since-last-log, so real long-gap changes aren't flagged) prompts a confirmation before saving — protects the rolling average, calibration, and completion-estimate math from typos. Applies the same way whether the weight was entered via the unified activity form or its inline edit row.

## Screens (bottom tab bar)
1. **Trail (Dashboard)** — hero card (current weight, goal, today's calorie target, calories eaten/remaining, progress bar); stat grid (total lost/gained + rolling avg, current phase + "Phase X of Y", current phase calories, estimated maintenance); a "Current strategy" card (deficit/surplus, calculated multiplier, calibration note, link to calc details); "Estimated timeline" card (next phase + goal ETAs); SVG trail visualization with hover tooltips; **"Calorie breakdown" donut chart** (see below); linear-regression weight trend chart; weekly pace insight banner; low-calorie warning banner (sex-specific floor).
2. **Roadmap** — full phase list with Reached/Current/Upcoming badges, each phase's calorie targets, and a banner disclosing when calibration/taper are affecting the numbers shown.
3. **Log** — unified "Log activity" tab (formerly separate Weight/Calories sub-tabs, now merged): one form per day with Date, Weight, and a Calories section where "+ Add" appends another calorie line item — a category dropdown (Breakfast/Lunch/Dinner/Snack/Drinks/Other, defaults to Breakfast) plus an amount — each removable, with a live running total; plus day-level protein/carbs/fat/water and notes. History lists one combined row per day (weight + total calories, with an "(N entries)" badge when multiple calorie line items exist), each with Edit (reopens that day's weight and full itemized calorie list for editing) and Delete (removes both the weight and calorie data for that day, with a confirmation prompt).
4. **Setup/Settings** — collects body stats, goal type, activity level; live BMR/TDEE/multiplier/starting-calories preview with low-calorie warning; collapsed "Advanced settings" (calculation mode, multiplier override, deficit/surplus incl. custom, phase interval, deficit taper toggle); Data section (export/import/reset).

## Calorie breakdown chart (`renderCalorieBreakdownCard`, on the Trail page)
Hand-rolled SVG donut chart (`renderDonutChart` — manual `stroke-dasharray`/`stroke-dashoffset` circle segments, not the SVG2 `pathLength` shortcut, for broader browser compatibility) showing what share of logged calories came from each `MEAL_CATEGORIES` bucket, with the total in the center and a legend listing each category's calories + percentage.
- **Date-range filter**: a chip row (`DATE_FILTERS`) — Today / Yesterday / This Week / Last Week / This Month / Last Month / This Year / Last Year / All Time. `getDateRange(preset)` resolves a preset to concrete start/end `Date`s (weeks run Sunday–Saturday; "All Time" spans from the earliest weight-or-nutrition log date to today); `categoryTotalsForRange(preset)` sums `meals[].calories` across all `nutritionLogs` entries whose date falls in that range, bucketed by category (any non-standard label — from legacy data — folds into "Other").
- **Compare mode**: a "Compare" toggle chip reveals a second filter row. With it on, `renderCompareView` renders two smaller donuts side-by-side (no legend on the minis, just the center total) labeled by their respective range, followed by a per-category table showing `A → B` calories and the signed delta (colored pine for a decrease, danger-red for an increase), and an overall total delta line. Lets a user directly answer "did I eat more Dinner calories this week vs. last week."
- Filter/compare state (`calorieBreakdownFilter`, `calorieBreakdownCompareOn`, `calorieBreakdownCompareFilter`) lives in module-level variables, not persisted — resets to "This Week" / compare-off on reload. Selecting any chip re-renders the whole dashboard view (`renderDashboard()`), consistent with the rest of the app's full-re-render style.

## Calculation details page (`openCalcDetails`)
A full-screen overlay (not a tab) reachable from the dashboard's strategy card. Walks through every step with real numbers plugged in: inputs → BMR formula → TDEE → calculated multiplier → starting calories (Day 1, fixed) → metabolic calibration (if active) → current phase (BMR recalculated at that weight → TDEE → tapered eating target). Falls back to a simpler weight×multiplier breakdown for legacy profiles.

## Notable implementation details
- Pure vanilla JS, template-string based re-rendering (`innerHTML` swaps), no framework, no libraries.
- `leastSquaresSlope` is a shared regression helper used by the trend chart, the recent-window completion estimate, and the calibration engine.
- `todayStr()` builds the date from local `Date` getters (not `toISOString()`) — the original UTC-based version could disagree with the locally-rendered header date in the evening for US/Americas users, causing "today" lookups (e.g. "eaten today") to mismatch.
- Trail SVG hover tooltips are custom (not native `<title>`): a transparent oversized hit-circle per point drives `mousemove`/`mouseleave` handlers positioning a floating tooltip `div`, clamped to stay inside the scrollable container.
- No image/chart libraries — all visualizations are hand-rolled inline SVG, including the calorie-breakdown donut.
- `MEAL_CATEGORY_COLORS` maps each of the 6 meal categories to an existing CSS custom property (gold/pine/pine-dark/moss) plus two additions introduced for this chart: `--sky` (Drinks) and reusing `--ink-soft` (Other) — kept in the same muted, low-saturation palette as the rest of the UI rather than introducing a separate "chart color" system.
- **Calorie line-item rows** (in the activity form and its edit row) are kept in an in-memory draft array (`activityDraftMeals` / `editActivityDraftMeals`) rather than re-read from the DOM on save. Typing in a row's label/calories only mutates that array entry and updates the total text directly (`oninput`) — it does *not* re-render the row markup, which would drop input focus on every keystroke. Only explicit Add/Remove clicks re-render the row list.

## Known limitations
- Single-device only (localStorage) — export/import is the only backup path; no automatic reminders to back up.
- No unit toggle — lbs/inches only.
- No authentication/multi-profile support; one profile per browser origin.
- Activity level is fixed at setup and doesn't vary day-to-day (no exercise-calorie logging) — calibration partially compensates over time, but there's no way to add back a specific workout's calories.
- Deficit/surplus math and calibration use the standard 3,500 kcal/lb energy-density conversion — a well-established approximation, not exact for any individual.
- No food database or barcode scanning — calorie/macro entry is manual.
