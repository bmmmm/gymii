# Hints — rules, thresholds, sources

A hint is one instruction about your own training, shown where you act on
it, with a ↗ to the study it rests on and no explainer (user, 2026-10-01:
"direkt die Anweisung, nur ein Hinweis zu den Docs"). They come from
`insights()` in `js/stats.js`, which is pure: workouts, layout, settings,
`now` and the saved plans go in, raw strings come out (the UI escapes via
`hintHtml()` in ui.js). **This file and the code are one contract — change
both together.** Thresholds below are the ones in the code;
test/stats.test.mjs pins every rule at its threshold and one step short of
it.

Every row carries `kind`, `text`, `score`, a `source` key into `SOURCES`
and its target: `machineId` + `exercise` (progress, plateau — `null` for a
whole-machine entry; the log screen and the Progress chart match on BOTH),
`machineId` + `weekday` (busy), `machineId` + `workout` (route — the name
those workouts go by most often, `null` when they have none), or `muscle`.
The text names no subject: the screen it sits on does. `SOURCES.own` ("Your
own logged workouts") has `url: null`, so route and busy render no link.

## Where each hint shows

| kind | where | only when |
|---|---|---|
| progress | Train log screen, below the machine head (train.js `renderLog`) | the machine AND exercise on screen |
| busy | Train log screen, below the machine head | the machine on screen, on `weekday` (today) |
| rest | the rest overlay, under "Next:" (train.js `openRestOverlay`) | — |
| plateau | History → Progress, `#chart-note` under the chart | the picked machine AND exercise |
| muscle-gap, muscle-volume | History → Muscles, a line under the muscle's row | — |
| frequency | History → This week, between the tiles and the bars | — |
| route | the plan builder, above the items in List view (plan.js); the plan's row on the start screen says "· reorder?" (train.js `planListCard`) | a plan named like `workout` |

History computes the list once per render over EVERY workout (never the
filtered list: "1.5 strength days a week" says nothing about one routine);
train.js and plan.js compute it per render of their screen.

## Order

- Nothing is returned with fewer than three workouts.
- `score` = the kind's weight plus a magnitude term, rounded and clamped to
  0–9. Weights: progress 50, plateau 40, busy 35, muscle-gap 30, route 30,
  frequency 25, rest 20, muscle-volume 15.
- Sorted by score, ties on the text. Everything that fires is returned —
  no cap, no one-per-machine pick: each screen filters to the thing on it,
  and a cap would silence the third machine. The order only decides which
  line comes first when a screen shows two (progress above busy).
- Rules 3, 4, 6 and 7 need a layout (muscles, machine positions); without one
  they stay silent.

## The rules

All "days" are whole calendar days between local midnights. "Strength"
means non-cardio entries; muscles come from resistance machines only (a
treadmill tagged Calves is not a calf set).

| # | kind | fires when | magnitude | text | source |
|---|---|---|---|---|---|
| 1 | progress | The latest session on a strength exercise is at most 20 days old, the last two sessions share the same top weight W, and in each one the target was beaten: the best reps at W are at least T + 2, or a set at W has reps ≥ T and `rir` ≥ 2. T = the target reps of the plan the latest session came from, else the first plan targeting that machine, else 12 | lowest reps at W minus T | "Target beaten twice — try 60 kg." The next load is W plus `settings.weightStep` (default 2.5); if that step is above 10 % of W: "Target beaten twice — add 1–2 reps first." | `acsm2009` |
| 2 | frequency | The first workout is at least 28 days old AND predates the oldest of the last four full weeks (a week the history only partly covers would read as a low week), and the mean number of strength days per week over the last four full weeks (the current week excluded) is below 2 | (2 − mean) × 4.5 | "Aim for 2 strength days a week — 1.5 over the last 4 weeks." | `who2020` |
| 3 | muscle-gap | A muscle was last trained 10 to 41 days ago, and at least two workouts happened in the last 10 days (so it is not a holiday) | days since − 10 | "Train it this week — last trained 12 days ago." | `schoenfeld2016` |
| 4 | muscle-volume | At least 28 days of history, at least 4 muscles with a non-zero 4-week mean (a tagged muscle nobody trains is untrained, not low volume — it is never named here), and the lowest 4-week mean of weekly sets is below half the median muscle's | scaled 0–9 by how far below half the median | "Add a set or two — 2 sets/week, your median muscle gets 9." | `schoenfeld2017` |
| 5 | rest | At least 10 rest gaps over the last five workouts that have stamped sets, median below 90 s. A gap is the time between two consecutive stamped sets of the same entry, 600 s at most; `at` is the END of a set, so it includes the next set itself | (90 − median) / 10 | "Hold 90 s — your median is 70 s (incl. the set)." | `pmc11349676` |
| 6 | route | The same backtrack (same machine A, then B, then back to a machine already visited, A → B → A excluded) shows up in at least three of the last eight workouts that have a path; counted once per workout | (workouts − 3) × 2 | "Reorder — back to #3 after #16 in 4 workouts." (`workout` carries the name those workouts go by most often, `null` when they have none — then no builder shows it) | `own` |
| 7 | busy | At least three `busy` marks on one machine, on the same weekday, within a two-hour span of wall-clock time, in the last 56 days | marks − 3 | "Usually busy Mondays 17–19 h — start elsewhere." | `own` |
| 8 | plateau | At least eight sessions with an estimated 1RM, none of the last six beating the best of the earlier ones, and the machine was trained in the last 21 days | workouts since the best − 6 | "No new best in 6 workouts (76 kg e1RM) — vary reps or load." | `pmc11435939` |

Estimated 1RM is Epley, `w × (1 + reps / 30)`, only for a real load and 1 to
10 reps (1 rep is the weight itself). Beyond 10 reps it overestimates badly,
and the figure is only ever compared within one exercise.

Rule 4 deliberately omits a "lowest is in the bottom quartile" clause: the
minimum is always at or below any percentile, so it could never decide
anything. Rule 3 stops at 42 days: a muscle untouched for six weeks is a
break, not a gap in a routine.

## What the sources say

| key | basis for the rule | link |
|---|---|---|
| `who2020` | strength training on 2 or more days a week, all major muscle groups; aerobic 150–300 min/week | https://pmc.ncbi.nlm.nih.gov/articles/PMC7719906/ |
| `acsm2009` | novices 8–12 RM; add 2–10 % load once the target is beaten by 1–2 reps | https://doi.org/10.1249/MSS.0b013e3181915670 |
| `garber2011` | each major muscle group 2–3 days a week, at least 48 h apart (soft) | https://doi.org/10.1249/MSS.0b013e318213fefb |
| `schoenfeld2016` | training a muscle twice a week beats once at equal volume | https://doi.org/10.1007/s40279-016-0543-8 |
| `schoenfeld2017` | about +0.37 % gain per extra weekly set; continuous, no threshold | https://doi.org/10.1080/02640414.2016.1210197 |
| `pelland2025` | diminishing returns with volume; indirect sets count about half | https://doi.org/10.1007/s40279-025-02344-w |
| `pmc11435939` | e1RM (Epley) valid up to 10 reps, overestimates 4–13 %, compare per exercise only | https://pmc.ncbi.nlm.nih.gov/articles/PMC11435939/ |
| `pmc11349676` | rests above 60–90 s help strength gains | https://pmc.ncbi.nlm.nih.gov/articles/PMC11349676/ |
| `detraining` | short breaks (under about two weeks) are harmless | https://doi.org/10.1111/sms.14739 |
| `own` | the user's own logged data (route, busy marks) — no study, no link | — |

`garber2011`, `pelland2025` and `detraining` are in `SOURCES` as background
for the choices below; no rule cites them yet.

## Deliberately not a rule

- **Hamstring-to-quad ratio (H:Q) and push:pull ratios.** The "ideal" values
  are convention; the evidence does not tie them to injury (see
  https://doi.org/10.1016/j.jshs.2022.01.002). A card telling the user
  their ratio is "off" would manufacture a problem. Rules 3 and 4 only flag
  clear omissions.
- **Calories (kcal).** An estimate needs body mass, which gymii does not
  store, and the figure would be sensitive data for little use.
- **Detraining nags.** Breaks under about two weeks are harmless, so a gap
  alone never produces a row: rule 3 requires that training goes on while one
  muscle drops out, and rule 2 nudges frequency, not absence.
- **Anything that needs metres.** Walking-path length is relative (grid
  units), so no rule compares it with a distance.
