// A three-way merge of JSON documents, for manifests such as package.json that two tasks change at once:
// each side's changes are applied key by key, so two dependencies added to the same object both land.
// Two different changes to the same value are a real conflict, which the caller leaves to a retry.

export const CONFLICT = Symbol('conflict');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Value = Json | undefined; // undefined: absent on that side

const isObject = (v: Value): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

export function mergeJson(base: Value, ours: Value, theirs: Value): Value | typeof CONFLICT {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (!isObject(ours) || !isObject(theirs)) return CONFLICT;
  const was = isObject(base) ? base : {};
  // Our keys in our order; a key only they have goes after the key it follows on their side. Every key
  // is merged, so one side deleting what the other changed is a conflict, not a silent loss.
  const keys = Object.keys(ours);
  let after = -1;
  for (const k of Object.keys(theirs)) {
    const at = keys.indexOf(k);
    if (at >= 0) after = at;
    else keys.splice(++after, 0, k);
  }
  const out: { [key: string]: Json } = {};
  for (const k of keys) {
    const merged = mergeJson(was[k], ours[k], theirs[k]);
    if (merged === CONFLICT) return CONFLICT;
    if (merged !== undefined) out[k] = merged;
  }
  return out;
}

// A package manifest's dependency maps stay in name order, as package managers write them.
const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export function sortDependencyMaps(manifest: Value): Value {
  if (!isObject(manifest)) return manifest;
  const out = { ...manifest };
  for (const k of DEPENDENCY_MAPS) {
    const map = out[k];
    if (isObject(map)) out[k] = Object.fromEntries(Object.keys(map).sort().map((name) => [name, map[name]!]));
  }
  return out;
}
