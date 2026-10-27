import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFLICT, mergeJson, sortDependencyMaps } from '../src/json-merge.ts';

// The merge queue's key-by-key merge of manifests such as package.json.

const base = { name: 'app', scripts: { build: 'tsc', test: 'vitest' }, devDependencies: { typescript: '6.0.3', vitest: '5.0.5' } };

test('json merge: two dependencies added to the same map both land, and each side keeps its own changes', () => {
  const ours = { ...base, scripts: { ...base.scripts, lint: 'eslint .' }, devDependencies: { ...base.devDependencies, yaml: '2.9.1' } };
  const theirs = { ...base, devDependencies: { ...base.devDependencies, actionlint: '2.0.6' } };
  assert.deepEqual(mergeJson(base, ours, theirs), {
    name: 'app',
    scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
    devDependencies: { typescript: '6.0.3', vitest: '5.0.5', yaml: '2.9.1', actionlint: '2.0.6' },
  });
});

test('json merge: a key only they added goes after the key it follows on their side', () => {
  const theirs = { ...base, scripts: { build: 'tsc', typecheck: 'tsc --noEmit', test: 'vitest' } };
  const merged = mergeJson(base, base, theirs) as { scripts: Record<string, string> };
  assert.deepEqual(Object.keys(merged.scripts), ['build', 'typecheck', 'test']);
  const ours = { ...base, scripts: { ...base.scripts, lint: 'eslint .' } };
  assert.deepEqual(Object.keys((mergeJson(base, ours, theirs) as { scripts: object }).scripts), ['build', 'typecheck', 'test', 'lint']);
});

test('json merge: the same value changed two ways, or deleted on one side and changed on the other, is a conflict', () => {
  const gate = (g: string) => ({ ...base, scripts: { ...base.scripts, gate: g } });
  assert.equal(mergeJson(gate('a && b'), gate('a && b && c'), gate('a && d && b')), CONFLICT);
  const { test: _, ...withoutTest } = base.scripts;
  assert.equal(mergeJson(base, { ...base, scripts: withoutTest }, { ...base, scripts: { ...base.scripts, test: 'vitest run' } }), CONFLICT);
  // Deleted on one side and untouched on the other: the deletion stands.
  assert.deepEqual(mergeJson(base, { ...base, scripts: withoutTest }, base), { ...base, scripts: withoutTest });
  // Both added the file (no base) with the same dependency at different versions.
  assert.equal(mergeJson(undefined, { dependencies: { a: '1' } }, { dependencies: { a: '2' } }), CONFLICT);
});

test('json merge: dependency maps come out in name order, as package managers write them', () => {
  const merged = sortDependencyMaps({ name: 'app', scripts: { z: 'z', a: 'a' }, devDependencies: { yaml: '1', actionlint: '1', eslint: '1' } });
  assert.deepEqual(Object.keys((merged as { devDependencies: object }).devDependencies), ['actionlint', 'eslint', 'yaml']);
  assert.deepEqual(Object.keys((merged as { scripts: object }).scripts), ['z', 'a'], 'other maps keep their order');
});
