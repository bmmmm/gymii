# History insights — rules, thresholds, sources

The "Worth a look" card on the History overview shows at most three
observations about your own training. They come from `insights()` in
`js/stats.js`, which is pure: workouts, layout, settings, `now` and the saved
plans go in, raw strings come out (the UI escapes). **This file and the code
are one contract — change both together.** Thresholds below are the ones in
the code; test/stats.test.mjs pins every rule at its threshold and one step
short of it.

Every row carries a `why` line and a `source` key into `SOURCES`. The UI
shows the source's label as a link to its `url`; `SOURCES.own` ("Your own
logged workouts") has `url: null`, so the rules that rest on the user's own
records render a label and no link.

## Ranking

- Nothing is returned with fewer than three workouts.
- `score` = the kind's weight plus a magnitude term, rounded and clamped to
  0–9. Weights: progress 50, plateau 40, busy 35, muscle-gap 30, route 30,
  frequency 25, rest 20, muscle-volume 15.
- Sorted by score, ties on the text; then at most 3 rows (`max`), at most one
  per kind (progress: two), and one per machine or muscle — a second row about
  the same machine or muscle is skipped.
- Rules 3, 4, 6 and 7 need a layout (muscles, machine positions); without one
  they stay silent.

## The rules

All "days" are whole calendar days between local midnights. "Strength"
means non-cardio entries; muscles come from resistance machines only (a
treadmill tagged Calves is not a calf set).

| # | kind | fires when | magnitude | text | source |
|---|---|---|---|---|---|
| 1 | progress | The last two sessions of one strength exercise share the same top weight W, and in each one the target was beaten: the best reps at W are at least T + 2, or a set at W has reps ≥ T and `rir` ≥ 2. T = the target reps of the plan the latest session came from, else the first plan targeting that machine, else 12 | lowest reps at W minus T | "#2 Lat pulldown: 12 × 57.5 kg twice — try 60 kg." The next load is W plus `settings.weightStep` (default 2.5); if that step is above 10 % of W: "… twice — add 1–2 reps first." | `acsm2009` |
| 2 | frequency | The first workout is at least 28 days old and the mean number of strength days per week over the last four full weeks (the current week excluded) is below 2 | (2 − mean) × 4.5 | "Last 4 weeks: 1.5 strength days/week." | `who2020` |
| 3 | muscle-gap | A muscle was last trained 10 to 41 days ago, and at least two workouts happened in the last 10 days (so it is not a holiday) | days since − 10 | "Hamstrings: last trained 12 days ago." | `schoenfeld2016` |
| 4 | muscle-volume | At least 28 days of history, at least 4 muscles tagged in the layout, and the lowest 4-week mean of weekly sets is below half the median muscle's | scaled 0–9 by how far below half the median | "Calves: 2 sets/week — your median muscle gets 9." | `schoenfeld2017` |
| 5 | rest | At least 10 rest gaps over the last five workouts that have stamped sets, median below 90 s. A gap is the time between two consecutive stamped sets of the same entry, 600 s at most; `at` is the END of a set, so it includes the next set itself | (90 − median) / 10 | "Median 70 s between sets (incl. the set)." | `pmc11349676` |
| 6 | route | The same backtrack (same machine A, then B, then back to a machine already visited, A → B → A excluded) shows up in at least three of the last eight workouts that have a path; counted once per workout | (workouts − 3) × 2 | "Pull day: back to #3 after #16 in 4 workouts — reorder the plan?" (the workout name is the one those workouts go by most often, omitted when they have none) | `own` |
| 7 | busy | At least three `busy` marks on one machine, on the same weekday, within a two-hour span of wall-clock time, in the last 56 days | marks − 3 | "#8 Pec deck busy 3× on Mondays 17–19 h." | `own` |
| 8 | plateau | At least eight sessions with an estimated 1RM, none of the last six beating the best of the earlier ones, and the machine was trained in the last 21 days | workouts since the best − 6 | "#1 Chest press: no new best in 6 workouts (76 kg e1RM)." | `pmc11435939` |

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
