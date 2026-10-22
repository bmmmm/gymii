// The gym editor's undo engine — pure, no imports (like merge.js), split
// off gym.js so it can be tested without a DOM. gym.js's save() and
// undo/redo are its only callers; docs/architecture.md § js/gym.js says
// why every write goes through it.
//
// --- undo entries ---
// An undo entry is what one edit CHANGED, part by part — each machine and
// shape by id, each structural field — never a snapshot of the whole
// layout. Undo and redo write that side of it onto the layout as stored
// IN THE TAP: a snapshot written back is a render-time copy (store.js,
// ensureMachine), and saveLayout tombstones every id such a copy lacks — a
// machine an ambient sync pull or another tab brought in meanwhile would
// die on every device, and their changes to the other parts would be
// reverted.
const STRUCTURAL = ['name', 'grid', 'meta', 'outline'];
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function layoutDiff(a, b) {
  const changes = STRUCTURAL.filter((field) => !same(a[field], b[field]))
    .map((field) => ({ field, before: clone(a[field]), after: clone(b[field]) }));
  ['machines', 'shapes'].forEach((coll) => {
    const la = a[coll] ?? [];
    const lb = b[coll] ?? [];
    const ia = new Map(la.map((it, i) => [it.id, i]));
    const ib = new Map(lb.map((it, i) => [it.id, i]));
    new Set([...ia.keys(), ...ib.keys()]).forEach((id) => {
      const before = la[ia.get(id)] ?? null;
      const after = lb[ib.get(id)] ?? null;
      if (same(before, after)) return;
      changes.push({
        coll, id, before: clone(before), after: clone(after), at: { before: ia.get(id), after: ib.get(id) },
      });
    });
  });
  return changes;
}

// Only the keys the edit changed, so a key another writer set since
// survives (a grip Train taught the machine whose type is being undone).
function writeKeys(target, want, was) {
  new Set([...Object.keys(want), ...Object.keys(was)]).forEach((k) => {
    if (same(want[k], was[k])) return;
    if (k in want) target[k] = clone(want[k]);
    else delete target[k];
  });
}

// side: 'before' undoes the entry, 'after' redoes it. A part the edit
// changed that another writer deleted since stays deleted.
export function applySide(target, changes, side) {
  const other = side === 'before' ? 'after' : 'before';
  changes.forEach((c) => {
    const want = c[side];
    const was = c[other];
    if (c.field) {
      if (isRecord(want) && isRecord(was) && isRecord(target[c.field])) writeKeys(target[c.field], want, was);
      else if (want === undefined) delete target[c.field];
      else target[c.field] = clone(want);
      return;
    }
    const list = (target[c.coll] ??= []);
    const i = list.findIndex((it) => it.id === c.id);
    if (!want) {
      if (i !== -1) list.splice(i, 1);
    } else if (i === -1) {
      if (!was) list.splice(Math.min(c.at[side], list.length), 0, clone(want));
    } else if (was) {
      writeKeys(list[i], want, was);
    } else {
      list[i] = clone(want);
    }
  });
}

// Another writer's changes minus what `mine` changed: a part only it
// touched comes whole; a part both touched keeps only its other keys (a
// part one side deleted or added whole is this edit's call).
export function foreignOnly(theirs, mine) {
  const key = (c) => (c.field ? `f:${c.field}` : `${c.coll}:${c.id}`);
  const own = new Map(mine.map((c) => [key(c), c]));
  return theirs.flatMap((c) => {
    const m = own.get(key(c));
    if (!m) return [c];
    if (![c.before, c.after, m.before, m.after].every(isRecord)) return [];
    const mineKeys = new Set(Object.keys({ ...m.before, ...m.after })
      .filter((k) => !same(m.before[k], m.after[k])));
    const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !mineKeys.has(k)));
    return [{ ...c, before: pick(c.before), after: pick(c.after) }];
  });
}
