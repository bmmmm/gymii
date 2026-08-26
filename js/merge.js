// Pure merge logic for cross-device sync — no DOM, no localStorage, no
// imports. The transport (js/sync.js, M1) decides WHEN to reconcile and
// hands whole per-profile states in; these functions only decide WHAT the
// reconciled state is. Conflict ordering between devices is the server's
// revision counter (never client clocks); `updatedAt` client stamps are
// used solely as the last-writer-wins tie-break WITHIN a merge, so a
// skewed phone clock can misorder one edit, never hijack the protocol.
//
// Shared model: every collection merges by stable id — union of both
// sides, whole-record LWW when both carry the same id, tombstones so a
// delete on one device cannot be resurrected by the other's copy. Records
// from before the sync groundwork carry no `updatedAt` and count as
// epoch 0: a never-restamped legacy record loses to any stamped edit.

export const stamp = (x) => x?.updatedAt ?? 0;

// Generic id-keyed collection merge. Returns the merged items (order
// unspecified — writers like saveWorkouts re-sort on save), the combined
// tombstones (max `at` per id), and whether LOCAL needs a rewrite
// (`changed`); whether the REMOTE needs a push is the caller's own
// comparison of merged vs remote.
export function mergeById(localItems, remoteItems, localTomb = [], remoteTomb = []) {
  const tombAt = new Map();
  [...localTomb, ...remoteTomb].forEach((t) => {
    tombAt.set(t.id, Math.max(tombAt.get(t.id) ?? -Infinity, t.at));
  });

  const local = new Map(localItems.map((i) => [i.id, i]));
  const remote = new Map(remoteItems.map((i) => [i.id, i]));

  const items = [];
  let changed = false;
  new Set([...local.keys(), ...remote.keys()]).forEach((id) => {
    const l = local.get(id);
    const r = remote.get(id);
    // ties (equal stamps — including the one-time both-unstamped legacy
    // ambiguity) resolve to LOCAL, deterministically
    const winner = l && r ? (stamp(r) > stamp(l) ? r : l) : (l ?? r);
    const deletedAt = tombAt.get(id);
    if (deletedAt !== undefined && deletedAt >= stamp(winner)) {
      if (l) changed = true; // local had it; the merge drops it
      return;
    }
    items.push(winner);
    if (JSON.stringify(l) !== JSON.stringify(winner)) changed = true;
  });

  const tombstones = [...tombAt].map(([id, at]) => ({ id, at }));
  return { items, tombstones, changed };
}

export function mergeWorkouts(local, remote, localTomb = [], remoteTomb = []) {
  // Two ids with near-identical content (a session logged live on one
  // device and back-logged on another) are NOT content-deduped — identity
  // is the id, full stop. Deduping is a UX question, never a merge rule.
  return mergeById(local, remote, localTomb, remoteTomb);
}

export function mergePlans(local, remote, localTomb = [], remoteTomb = []) {
  // whole-record LWW also carries the winner's createdAt — first-write-wins
  // semantics survive because the field always travels with its record
  return mergeById(local, remote, localTomb, remoteTomb);
}

// Gym is a hybrid: machines and shapes are id-keyed collections (machines
// are created outside the studio too — quick start, create-on-miss, plan
// binding — so two offline sessions adding stations is an everyday case
// that a whole-gym LWW would silently half-discard). The structural rest
// (name, grid, meta, outline) has no per-item ids and merges as one blob
// via the gym-level `updatedAt`.
const GYM_STRUCTURAL = ['v', 'name', 'grid', 'meta', 'outline', 'updatedAt'];

export function mergeGym(local, remote, localTomb = {}, remoteTomb = {}) {
  const machines = mergeById(local.machines ?? [], remote.machines ?? [],
    localTomb.machines ?? [], remoteTomb.machines ?? []);
  const shapes = mergeById(local.shapes ?? [], remote.shapes ?? [],
    localTomb.shapes ?? [], remoteTomb.shapes ?? []);
  const base = stamp(remote) > stamp(local) ? remote : local;
  const merged = {};
  GYM_STRUCTURAL.forEach((f) => { if (f in base) merged[f] = base[f]; });
  merged.machines = machines.items;
  merged.shapes = shapes.items;
  const changed = machines.changed || shapes.changed
    || (base === remote && GYM_STRUCTURAL.some(
      (f) => JSON.stringify(local[f]) !== JSON.stringify(remote[f])));
  return {
    merged,
    tombstones: { machines: machines.tombstones, shapes: shapes.tombstones },
    changed,
  };
}

// Registry merge. `activeId` is device-local by definition (two devices
// may look at different profiles at once) — it is never taken from remote,
// only healed when the merge removed the profile it pointed at. A profile
// tombstone supersedes everything under that profile's namespace; callers
// drop the scoped keys, no per-item tombstones needed inside.
export function mergeProfiles(local, remote) {
  const { items, tombstones, changed } = mergeById(
    local.list ?? [], remote.list ?? [], local.deleted ?? [], remote.deleted ?? []);
  const merged = { ...local, list: items };
  if (tombstones.length) merged.deleted = tombstones;
  if (!merged.list.some((p) => p.id === merged.activeId)) {
    merged.activeId = merged.list[0]?.id ?? null;
  }
  return { merged, changed: changed || merged.activeId !== local.activeId };
}

// Settings split by FIELD, not by storage key: user-scoped preferences
// follow the newer side, device-scoped ones (map/timer/battery behavior)
// never leave the device. `aiPrompt` is crafted content, not a device
// quirk — user-scoped. `unit` syncing shrinks the mixed-unit window; the
// transport additionally normalizes values via convertWeight/-Distance
// before merging collections when units still differ (see docs).
export const USER_SETTINGS = ['unit', 'weightStep', 'restSeconds', 'aiPrompt'];

export function mergeSettings(local, remote) {
  const merged = { ...local };
  if (stamp(remote) > stamp(local)) {
    USER_SETTINGS.forEach((k) => {
      if (k in remote) merged[k] = remote[k];
      else delete merged[k]; // an absent user field (reset prompt) wins too
    });
    merged.updatedAt = remote.updatedAt;
  }
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(local) };
}
