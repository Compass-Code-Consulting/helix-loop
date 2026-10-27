import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await exec('git', args, { cwd });
    return true;
  } catch {
    return false;
  }
}

// Fetches, pushes and ls-remote never prompt for credentials and give up after two minutes, so a dead
// network or a missing credential fails that one operation instead of stalling the repo's merge queue.
// The output, or null when the operation failed.
export async function gitNet(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitNetOk(cwd: string, ...args: string[]): Promise<boolean> {
  return (await gitNet(cwd, ...args)) !== null;
}

export const branchFor = (taskId: string, agent: string, attempt: number) => `task/${taskId}-${agent}-${attempt}`;

// A fresh worktree from main for one pass. Any leftover from a crashed pass at the same path is removed first.
export async function addWorktree(repo: string, path: string, branch: string): Promise<void> {
  if (existsSync(path)) await removeWorktree(repo, path);
  await gitOk(repo, 'branch', '-D', branch);
  await git(repo, 'worktree', 'add', '-b', branch, path, 'main');
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await gitOk(repo, 'worktree', 'remove', '--force', path);
  await gitOk(repo, 'worktree', 'prune');
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, 'status', '--porcelain', '--untracked-files=all')) !== '';
}

export async function head(cwd: string, ref = 'HEAD'): Promise<string> {
  return git(cwd, 'rev-parse', ref);
}

export async function commitsAhead(cwd: string, base: string): Promise<number> {
  return Number(await git(cwd, 'rev-list', '--count', `${base}..HEAD`));
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const out = await git(cwd, 'diff', '--name-only', `${base}...HEAD`);
  return out ? out.split('\n') : [];
}

// The lines the branch adds since it left `base` that git takes for leftover conflict markers, as "file:line".
// `git diff --check` reports whitespace errors too; those are the linters' business, so only markers are read.
export async function addedConflictMarkers(cwd: string, base: string): Promise<string[]> {
  const out = await exec('git', ['diff', '--check', `${base}...HEAD`], { cwd, maxBuffer: 64 * 1024 * 1024 }).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? '',
  );
  return out.split('\n').flatMap((l) => /^(.+:\d+): leftover conflict marker$/.exec(l)?.[1] ?? []);
}

export async function hasRemote(cwd: string): Promise<boolean> {
  return gitOk(cwd, 'remote', 'get-url', 'origin');
}

// Files many tasks append to (AGENTS.md, docs/architecture.md, .env.example) merge with git's union driver,
// keeping both sides instead of stopping a rebase. It lives in the clone's own info/attributes, which every
// worktree reads and nothing commits. Returns whether the file changed.
export async function ensureUnionMerge(repo: string, paths: string[]): Promise<boolean> {
  if (!paths.length) return false;
  const file = await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/attributes');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = paths.filter((p) => !current.split('\n').some((l) => l.trim() === `${p} merge=union`));
  if (!missing.length) return false;
  mkdirSync(dirname(file), { recursive: true });
  const header = current.includes('union driver') ? '' : '# Written by the loop: files many tasks append to merge by keeping both sides (git\'s union driver).\n';
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${header}${missing.map((p) => `${p} merge=union`).join('\n')}\n`);
  return true;
}
