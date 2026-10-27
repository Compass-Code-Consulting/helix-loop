import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUnionMerge } from '../src/git.ts';

// Shared append-only files merge with git's union driver, set in the clone's own info/attributes.

const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { cwd }).toString().trim();

test('git: union merge is set once in info/attributes, and a rebase then keeps both appended lines', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'union-'));
  run(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'AGENTS.md'), '# Commands\n- pnpm gate\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-qm', 'base');
  run(repo, 'checkout', '-qb', 'task');
  writeFileSync(join(repo, 'AGENTS.md'), '# Commands\n- pnpm gate\n- pnpm dev\n');
  run(repo, 'commit', '-qam', 'task');
  run(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'AGENTS.md'), '# Commands\n- pnpm gate\n- pnpm db\n');
  run(repo, 'commit', '-qam', 'main');
  assert.equal(await ensureUnionMerge(repo, ['AGENTS.md', '.env.example']), true);
  assert.equal(await ensureUnionMerge(repo, ['AGENTS.md', '.env.example']), false, 'a second run changes nothing');
  assert.match(readFileSync(join(repo, '.git', 'info', 'attributes'), 'utf8'), /^AGENTS\.md merge=union$/m);
  run(repo, 'checkout', '-q', 'task');
  run(repo, 'rebase', '--quiet', 'main');
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# Commands\n- pnpm gate\n- pnpm db\n- pnpm dev\n');
});
