// Weekday plans: what is due, what was missed, what today is for. Pure
// date maths over `now` — no imports, no storage; store.js's skipPlanDay is
// the one writer and lives with the other plan writes.
// A plan tagged with weekdays turns the start screen into an answer to
// "what today is about" — including the answer "nothing", which is a real
// one. Tone is stated, never scolding: gymii reports, it does not nag.
// All of this is pure date maths over `now`, so it is testable without
// waiting for a Tuesday.

// Local midnight as a Date — THE day-boundary definition (demo.js imports
// it too; day arithmetic goes through setDate(), never DAY_MS multiples,
// which drift an hour across DST transitions).
export const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};
export const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The plan's most recent due day at or before `now` (today counts), or
// null when it carries no weekdays.
export function planDueDay(plan, now = Date.now()) {
  if (!plan.days?.length) return null;
  for (let back = 0; back < 7; back++) {
    const d = startOfDay(now);
    d.setDate(d.getDate() - back);
    if (plan.days.includes(d.getDay())) return d;
  }
  return null;
}

// The next due day strictly after today.
export function planNextDay(plan, now = Date.now()) {
  if (!plan.days?.length) return null;
  for (let ahead = 1; ahead <= 7; ahead++) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + ahead);
    if (plan.days.includes(d.getDay())) return d;
  }
  return null;
}

// Was this plan trained since `since`? New workouts carry planId; older
// ones are matched by name, which is how a plan owned its routine before.
const planTrainedSince = (plan, workouts, since) => workouts.some((w) =>
  (w.planId === plan.id || (plan.name && w.name === plan.name))
  && w.startedAt >= since.getTime());

// How this plan stands right now: 'due' (today, not trained yet), 'done'
// (today, already trained), 'missed' (an earlier day this cycle went by),
// 'skipped', or 'clear' (nothing outstanding). Missed days only reach back
// to the previous occurrence of that weekday — a skipped Tuesday stops
// mattering next Tuesday, so a holiday never becomes a backlog.
export function planDayState(plan, workouts, now = Date.now()) {
  const due = planDueDay(plan, now);
  if (!due) return { state: 'clear', due: null, next: null };
  const next = planNextDay(plan, now);
  const isToday = due.getTime() === startOfDay(now).getTime();
  // a day that passed before this plan existed was never missed
  if (plan.createdAt && due.getTime() < startOfDay(plan.createdAt).getTime()) {
    return { state: 'clear', due, next };
  }
  if (planTrainedSince(plan, workouts, due)) {
    return { state: isToday ? 'done' : 'clear', due, next };
  }
  if (plan.skippedOn === dayKey(due)) return { state: 'skipped', due, next };
  if (isToday) return { state: 'due', due, next };
  // A day only counts as MISSED while the rhythm is alive — the cycle
  // before it was trained. A plan never started, or dropped weeks ago, is
  // not missed every single week; it just isn't running, and saying so
  // every Monday would be nagging rather than reminding.
  const prevCycle = new Date(due);
  prevCycle.setDate(prevCycle.getDate() - 7);
  if (!planTrainedSince(plan, workouts, prevCycle)) return { state: 'clear', due, next };
  return { state: 'missed', due, next };
}

// The one thing the start screen should say about today. Plans are scanned
// in stored order and the most actionable state wins: something due today
// beats a missed day, which beats "done", which beats a rest day.
export function todayStatus(plans, workouts, now = Date.now()) {
  const dated = plans.filter((p) => p.days?.length);
  if (!dated.length) return null;
  const states = dated.map((p) => ({ plan: p, ...planDayState(p, workouts, now) }));
  const pick = (state) => states.find((x) => x.state === state) ?? null;
  const hit = pick('due') ?? pick('missed') ?? pick('done');
  if (hit) return hit;
  // nothing outstanding: name the next plan that comes up, soonest first
  const upcoming = states.filter((x) => x.next)
    .sort((a, b) => a.next - b.next)[0];
  return upcoming ? { ...upcoming, state: 'rest' } : null;
}

// The weekday this plan actually gets trained on, when there is a clear
// one (at least 3 workouts, and 60% of them on the same day). Lets gymii
// notice a rhythm instead of asking for one.
export function usualWeekday(plan, workouts) {
  const mine = workouts.filter((w) =>
    w.planId === plan.id || (plan.name && w.name === plan.name));
  if (mine.length < 3) return null;
  const counts = new Map();
  mine.forEach((w) => {
    const d = new Date(w.startedAt).getDay();
    counts.set(d, (counts.get(d) || 0) + 1);
  });
  const [day, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return hits / mine.length >= 0.6 ? day : null;
}
