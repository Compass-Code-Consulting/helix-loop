import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addedConflictMarkers } from '../src/git.ts';
import { carryInto } from '../src/merge.ts';

// Work kept on an earlier attempt's branch, merged into the next attempt's fresh worktree (merge.ts, carryInto),
// and the gate's refusal of the conflict markers a branch adds.

const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { cwd }).toString().trim();
const write = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
};
const KEPT = 'task/T-0001-claude-1';

// A repo whose main and kept branch both moved on from a common base, and a fresh worktree from main, as
// the next attempt gets.
function setup(base: Record<string, string>, kept: Record<string, string>, main: Record<string, string>, deletedOnMain: string[] = []) {
  const repo = mkdtempSync(join(tmpdir(), 'carry-'));
  run(repo, 'init', '-q', '-b', 'main');
  write(repo, base);
  run(repo, 'add', '-A');
  run(repo, 'commit', '-qm', 'base');
  run(repo, 'checkout', '-qb', KEPT);
  write(repo, kept);
  run(repo, 'add', '-A');
  run(repo, 'commit', '-qm', 'the kept work');
  run(repo, 'checkout', '-q', 'main');
  write(repo, main);
  for (const f of deletedOnMain) run(repo, 'rm', '-q', f);
  run(repo, 'add', '-A');
  run(repo, 'commit', '-qm', 'main moves on');
  const worktree = `${repo}-next`;
  run(repo, 'worktree', 'add', '-q', '-b', 'task/T-0001-codex-2', worktree, 'main');
  return { repo, worktree, read: (f: string) => readFileSync(join(worktree, f), 'utf8') };
}

const RESOLVERS = {
  jsonMerge: { 'manifest.json': '' },
  relock: { 'manifest.lock': `node -e "const m = require('./manifest.json'); process.stdout.write(Object.keys(m.dependencies).sort().join('\\n') + '\\n')" > manifest.lock` },
};

test('carry: the kept work lands on the new main uncommitted; a conflict leaves zdiff3 markers and git says what it left', async () => {
  const s = setup(
    { 'shared.txt': 'one\ntwo\nthree\n', 'gone.txt': 'keep\n' },
    { 'shared.txt': 'one\nTWO-kept\nthree\n', 'src/new.ts': 'export const a = 1;\n', 'gone.txt': 'keep\nmore\n' },
    { 'shared.txt': 'one\nTWO-main\nthree\n', 'other.txt': 'main\n' },
    ['gone.txt'],
  );
  const c = await carryInto(s.worktree, KEPT, RESOLVERS);
  assert.ok(c.ok, JSON.stringify(c));
  assert.deepEqual(c.conflicts, ['gone.txt', 'shared.txt']);
  assert.deepEqual(c.resolved, []);
  assert.ok(c.messages.includes('CONFLICT (content): Merge conflict in shared.txt'), c.messages.join('\n'));
  assert.ok(c.messages.some((m) => /^CONFLICT \(modify\/delete\): gone\.txt deleted in HEAD and modified in task\/T-0001-claude-1/.test(m)), c.messages.join('\n'));
  assert.match(s.read('shared.txt'), /^one\n<<<<<<< HEAD\nTWO-main\n\|\|\|\|\|\|\| [0-9a-f]+\ntwo\n=======\nTWO-kept\n>>>>>>> task\/T-0001-claude-1\nthree\n$/);
  assert.equal(s.read('src/new.ts'), 'export const a = 1;\n');
  assert.equal(s.read('gone.txt'), 'keep\nmore\n', "the kept work's version stays, for the agent to judge");
  assert.equal(s.read('other.txt'), 'main\n');
  assert.equal(run(s.worktree, 'diff', '--cached', '--name-only'), '', 'nothing is staged');
  assert.equal(run(s.worktree, 'rev-parse', 'HEAD'), run(s.repo, 'rev-parse', 'main'), 'nothing is committed');
});

test('carry: a clean merge leaves no conflicts; a missing branch, or work main already holds, carries nothing', async () => {
  const s = setup({ 'a.txt': 'a\n' }, { 'b.txt': 'b\n' }, { 'c.txt': 'c\n' });
  const missing = await carryInto(s.worktree, 'task/T-0001-claude-9', RESOLVERS);
  assert.deepEqual(missing, { ok: false, why: 'branch task/T-0001-claude-9 no longer exists' });
  const c = await carryInto(s.worktree, KEPT, RESOLVERS);
  assert.deepEqual(c, { ok: true, conflicts: [], messages: [], resolved: [] });
  assert.equal(s.read('b.txt'), 'b\n');
  run(s.repo, 'merge', '-q', '--no-edit', KEPT);
  const later = `${s.repo}-later`;
  run(s.repo, 'worktree', 'add', '-q', '-b', 'task/T-0001-codex-3', later, 'main');
  assert.deepEqual(await carryInto(later, KEPT, RESOLVERS), { ok: false, why: `main already holds everything on ${KEPT}` });
  assert.equal(run(later, 'status', '--porcelain'), '', 'the worktree is left clean');
});

test('carry: conflicting manifests and lockfiles are resolved as in a rebase, while other conflicts keep their markers', async () => {
  const manifest = (deps: string[]) => `${JSON.stringify({ name: 'x', dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])) }, null, 2)}\n`;
  const s = setup(
    { 'manifest.json': manifest(['a']), 'manifest.lock': 'a\n', 'shared.txt': 'one\n' },
    { 'manifest.json': manifest(['a', 'k']), 'manifest.lock': 'a\nk\n', 'shared.txt': 'kept\n' },
    { 'manifest.json': manifest(['a', 'm']), 'manifest.lock': 'a\nm\n', 'shared.txt': 'main\n' },
  );
  const c = await carryInto(s.worktree, KEPT, RESOLVERS);
  assert.ok(c.ok, JSON.stringify(c));
  assert.deepEqual(c.conflicts, ['shared.txt']);
  assert.deepEqual(c.resolved, ['manifest.json', 'manifest.lock']);
  assert.deepEqual(c.messages, ['CONFLICT (content): Merge conflict in shared.txt'], 'only what is left to resolve');
  assert.deepEqual(JSON.parse(s.read('manifest.json')).dependencies, { a: '1.0.0', k: '1.0.0', m: '1.0.0' });
  assert.equal(s.read('manifest.lock'), 'a\nk\nm\n');
  assert.match(s.read('shared.txt'), /^<<<<<<< HEAD\nmain\n/);
});

test('carry: a manifest conflict it cannot resolve keeps the markers git left, and its lockfile waits for it', async () => {
  const manifest = (v: string) => `${JSON.stringify({ name: 'x', dependencies: { a: v } }, null, 2)}\n`;
  const s = setup(
    { 'manifest.json': manifest('1.0.0'), 'manifest.lock': 'a@1\n' },
    { 'manifest.json': manifest('2.0.0'), 'manifest.lock': 'a@2\n' },
    { 'manifest.json': manifest('3.0.0'), 'manifest.lock': 'a@3\n' },
  );
  const c = await carryInto(s.worktree, KEPT, RESOLVERS);
  assert.ok(c.ok, JSON.stringify(c));
  assert.deepEqual(c.conflicts.sort(), ['manifest.json', 'manifest.lock']);
  assert.match(s.read('manifest.json'), /<<<<<<< HEAD\n.*"3\.0\.0"[\s\S]*=======\n.*"2\.0\.0"\n[\s\S]*>>>>>>> task\/T-0001-claude-1/);
  assert.match(s.read('manifest.lock'), /^<<<<<<< HEAD\na@3\n/);
});

test('gate: the conflict markers a branch adds are found, by git rules, and markers already on main are not', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'markers-'));
  run(repo, 'init', '-q', '-b', 'main');
  write(repo, { 'fixture.txt': 'a parser fixture:\n<<<<<<< ours\n' });
  run(repo, 'add', '-A');
  run(repo, 'commit', '-qm', 'base');
  run(repo, 'checkout', '-qb', 'task/T-0002-codex-1');
  write(repo, {
    'fixture.txt': 'a parser fixture:\n<<<<<<< ours\nmore\n',
    'notes.md': 'Title\n=====\n\nA heading underline is not a marker.\n',
    'src/a.ts': 'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> task/T-0002-claude-1\n',
  });
  run(repo, 'add', '-A');
  run(repo, 'commit', '-qm', 'work');
  assert.deepEqual(await addedConflictMarkers(repo, 'main'), ['src/a.ts:2', 'src/a.ts:4', 'src/a.ts:6']);
  run(repo, 'checkout', '-q', 'main');
  assert.deepEqual(await addedConflictMarkers(repo, 'main'), [], 'nothing added, nothing found');
});
