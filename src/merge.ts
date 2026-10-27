import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { git, gitNetOk, gitOk, hasRemote, head } from './git.ts';
import { CONFLICT, mergeJson, sortDependencyMaps, type Value } from './json-merge.ts';
import { sh } from './proc.ts';

// One serial merge queue per repo (design doc §7.3). Only the loop moves main: catch main up with
// origin/main, rebase the task branch onto main, re-run the gate if main moved since the branch was
// gated, then fast-forward. A conflict sends the task back to the queue; agents never resolve
// conflicts against each other. The exceptions are manifests and lockfiles, resolved mechanically (see rebase).
// Work that passed its gate but met a main that had moved on is kept, and the next attempt starts from it (carryInto).

const exec = promisify(execFile);

// mainMoved: the commits main gained after the pass's gate ran; regateMs: how long the re-gate took, if one ran.
interface MergeTiming {
  mainMoved: number;
  regateMs?: number;
}
export type MergeResult =
  | ({ ok: true; commit: string; regated: boolean; pushed: boolean | 'skipped'; pushNote?: string; fromOrigin?: string; resolved: string[] } & MergeTiming)
  // carry: the work passed its own gate and only met a main that had moved on. failedStep: rebase, gitleaks,
  // origin, or the re-gate's own failed step as regate:<step>.
  | ({ ok: false; outcome: 'conflict' | 'gate_failed' | 'diverged'; detail: string; regated: boolean; failing?: string; carry?: boolean; failedStep: string } & MergeTiming);

export class MergeQueue {
  private tails = new Map<string, Promise<unknown>>();

  // Runs `job` after every earlier job for the same repo has finished.
  enqueue<T>(repo: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(repo) ?? Promise.resolve();
    const next = prev.then(job, job);
    this.tails.set(repo, next.catch(() => undefined));
    return next;
  }
}

export interface MergeInput {
  repo: string; // the primary checkout, on main
  worktree: string;
  branch: string;
  gatedOn: string; // the main commit the gate ran against
  regate: () => Promise<{ ok: boolean; detail: string; failing?: string; failedStep?: string; gateMs?: number }>;
  push: boolean;
  relock?: Record<string, string>; // lockfile name → the command that regenerates it from the manifests
  jsonMerge?: Record<string, string>; // manifest name → the command that formats it after a merge ('' for none)
}

// Where main stands against origin/main, fetched just now. 'unknown' when there is no origin or it
// cannot be fetched (offline, or no main there yet): the merge goes ahead and its push reports itself.
export interface OriginState {
  relation: 'same' | 'behind' | 'ahead' | 'diverged' | 'unknown';
  local: string;
  remote?: string;
  detail?: string; // when diverged: who has what
}

export async function compareWithOrigin(repo: string): Promise<OriginState> {
  const local = await head(repo, 'main');
  if (!(await hasRemote(repo))) return { relation: 'unknown', local };
  if (!(await gitNetOk(repo, 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'))) return { relation: 'unknown', local };
  const remote = await head(repo, 'refs/remotes/origin/main');
  if (remote === local) return { relation: 'same', local, remote };
  if (await gitOk(repo, 'merge-base', '--is-ancestor', local, remote)) return { relation: 'behind', local, remote };
  if (await gitOk(repo, 'merge-base', '--is-ancestor', remote, local)) return { relation: 'ahead', local, remote };
  const [ours, theirs] = (await git(repo, 'rev-list', '--left-right', '--count', `${local}...${remote}`)).split(/\s+/);
  const detail = `main (${local.slice(0, 12)}) and origin/main (${remote.slice(0, 12)}) have diverged: main has ${ours} commit(s) that origin lacks, and origin has ${theirs} that main lacks`;
  return { relation: 'diverged', local, remote, detail };
}

export async function mergeTask(input: MergeInput): Promise<MergeResult> {
  const { repo, worktree, branch } = input;
  // Someone may have pushed to origin/main since the loop last did. Take their commits first, so this
  // merge's push is a fast-forward; a main that has diverged from origin/main waits for a person.
  let fromOrigin: string | undefined;
  if (input.push) {
    const origin = await compareWithOrigin(repo);
    if (origin.relation === 'diverged') return { ok: false, outcome: 'diverged', detail: origin.detail!, regated: false, failedStep: 'origin', mainMoved: 0 };
    if (origin.relation === 'behind') {
      await git(repo, 'merge', '--ff-only', '--quiet', origin.remote!);
      fromOrigin = origin.remote;
    }
  }
  const mainNow = await head(repo, 'main');
  const mainMoved = mainNow === input.gatedOn ? 0 : Number(await git(repo, 'rev-list', '--count', `${input.gatedOn}..${mainNow}`).catch(() => '0'));
  let regated = false;
  let regateMs: number | undefined;
  const resolved: string[] = [];
  if (mainNow !== input.gatedOn) {
    const conflicted = await rebase(worktree, { relock: input.relock ?? {}, jsonMerge: input.jsonMerge ?? {} }, resolved);
    if (conflicted) {
      await gitOk(worktree, 'rebase', '--abort');
      const detail = `rebase onto main conflicts in: ${conflicted.join(', ') || 'unknown files'}`;
      return { ok: false, outcome: 'conflict', detail, regated, carry: true, failedStep: 'rebase', mainMoved };
    }
    regated = true;
    const g = await input.regate();
    regateMs = g.gateMs;
    if (!g.ok) {
      return {
        ok: false,
        outcome: 'gate_failed',
        detail: `after rebasing onto the new main: ${g.detail}`,
        regated,
        failing: g.failing && `after rebasing onto the new main, ${g.failing}`,
        carry: true,
        failedStep: `regate:${g.failedStep ?? 'gate'}`,
        mainMoved,
        regateMs,
      };
    }
  }
  // Never merge a secret: scan exactly the commits about to land. The note names each finding's rule, file
  // and line, never its value (redacted), so the next attempt knows what to change.
  try {
    await exec('gitleaks', ['git', '--no-banner', '--redact', '--verbose', '--exit-code', '1', `--log-opts=main..${branch}`, worktree]);
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ''}\n${(e as { stderr?: string }).stderr ?? ''}`;
    const found = secretFindings(out).map((x) => `${x.file}:${x.line} (${x.rule})`);
    if (!found.length) {
      const detail = `gitleaks could not scan the task's commits:\n${out.slice(-1500)}`;
      return { ok: false, outcome: 'gate_failed', detail, regated, failing: 'gitleaks could not scan its commits', failedStep: 'gitleaks', mainMoved, regateMs };
    }
    return {
      ok: false,
      outcome: 'gate_failed',
      failedStep: 'gitleaks',
      mainMoved,
      regateMs,
      detail: `gitleaks found what looks like a secret in the task's commits, at ${found.join(', ')}. A real secret must never be committed. A test fixture that needs a secret-shaped value builds it at run time instead, such as 'sk_live_' + 'x'.repeat(24), so the source holds nothing that looks real.`,
      regated,
      failing: `gitleaks flagged ${found[0]}${found.length > 1 ? `, and ${found.length - 1} more` : ''}`,
    };
  }
  await git(repo, 'merge', '--ff-only', '--quiet', branch);
  const commit = await head(repo, 'main');

  if (!input.push || !(await hasRemote(repo))) return { ok: true, commit, regated, pushed: 'skipped', fromOrigin, resolved, mainMoved, regateMs };
  const pushed = await gitNetOk(repo, 'push', '--quiet', 'origin', 'main');
  return { ok: true, commit, regated, pushed, fromOrigin, resolved, mainMoved, regateMs, pushNote: pushed ? undefined : 'push failed; the next merge will push again' };
}

export interface Resolvers {
  relock: Record<string, string>; // lockfile name → the command that regenerates it from the manifests
  jsonMerge: Record<string, string>; // manifest name → the command that formats it after a merge ('' for none)
}

const isManifest = (fix: Resolvers, file: string) => Object.hasOwn(fix.jsonMerge, basename(file));
const isLockfile = (fix: Resolvers, file: string) => Object.hasOwn(fix.relock, basename(file));

// Where a conflicted file's versions are: the common base (stage 1), main's (2) and the task's (3), each as an
// object name `git cat-file` reads, or undefined where the file is absent.
type Stages = (file: string, stage: 1 | 2 | 3) => string | undefined;

// Rebases the worktree's branch onto main, and returns the files left in conflict, if any. A conflict only in
// manifests and lockfiles is resolved (resolveDependencyFiles) and the rebase goes on. The re-gate installs
// from the result with a frozen lockfile, so a bad resolution still fails there.
async function rebase(worktree: string, fix: Resolvers, resolved: string[]): Promise<string[] | undefined> {
  if (await gitOk(worktree, 'rebase', '--quiet', 'main')) return undefined;
  for (let step = 0; step < 100; step++) {
    const files = (await git(worktree, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter(Boolean);
    if (!files.length || !files.every((f) => isManifest(fix, f) || isLockfile(fix, f))) return files;
    if ((await resolveDependencyFiles(worktree, fix, files, (f, n) => `:${n}:${f}`)).length) return files;
    resolved.push(...files.filter((f) => !resolved.includes(f)));
    await git(worktree, 'add', '--', ...files);
    if (await gitOk(worktree, '-c', 'core.editor=true', 'rebase', '--continue')) return undefined;
  }
  return [];
}

// Resolves the conflicted manifests and lockfiles among `files`: each manifest is merged key by key and
// formatted, then each lockfile takes main's copy and is regenerated from the merged manifests. Returns the
// files still in conflict.
async function resolveDependencyFiles(worktree: string, fix: Resolvers, files: string[], stages: Stages): Promise<string[]> {
  const left = files.filter((f) => !isManifest(fix, f) && !isLockfile(fix, f));
  for (const f of files.filter((f) => isManifest(fix, f))) {
    if (!(await mergeManifest(worktree, f, fix.jsonMerge[basename(f)]!, stages))) left.push(f);
  }
  const lockfiles = files.filter((f) => isLockfile(fix, f));
  // A lockfile is regenerated from the manifests, so not while one of them is still in conflict.
  if (left.some((f) => isManifest(fix, f))) return [...left, ...lockfiles];
  for (const f of lockfiles) {
    const main = await blob(worktree, stages(f, 2));
    if (main !== undefined) writeFileSync(join(worktree, f), main);
    const res = main === undefined ? undefined : await sh(fix.relock[basename(f)]!, { cwd: join(worktree, dirname(f)), timeoutMs: 5 * 60_000 });
    if (!res || res.code !== 0 || res.timedOut) left.push(f);
  }
  return left;
}

// An object's content, exactly; undefined when there is no such object.
async function blob(worktree: string, name: string | undefined): Promise<string | undefined> {
  if (name === undefined) return undefined;
  return exec('git', ['cat-file', 'blob', name], { cwd: worktree, maxBuffer: 256 * 1024 * 1024 }).then(
    (r) => r.stdout,
    () => undefined,
  );
}

// Main's version (ours), the task's (theirs) and their common base, merged key by key.
async function mergeManifest(worktree: string, file: string, format: string, stages: Stages): Promise<boolean> {
  const stage = async (n: 1 | 2 | 3): Promise<Value> => {
    try {
      return JSON.parse((await blob(worktree, stages(file, n))) ?? '') as Value;
    } catch {
      return undefined; // absent at that stage (added or deleted on one side), or not JSON
    }
  };
  const [base, ours, theirs] = [await stage(1), await stage(2), await stage(3)];
  if (ours === undefined || theirs === undefined) return false;
  const merged = mergeJson(base, ours, theirs);
  if (merged === CONFLICT) return false;
  writeFileSync(join(worktree, file), `${JSON.stringify(sortDependencyMaps(merged), null, 2)}\n`);
  if (!format) return true;
  const res = await sh(`${format} '${file.replace(/'/g, `'\\''`)}'`, { cwd: worktree, timeoutMs: 60_000 });
  return res.code === 0 && !res.timedOut;
}

export type CarryResult =
  | { ok: true; conflicts: string[]; messages: string[]; resolved: string[] }
  | { ok: false; why: string };

// Merges the work kept on an earlier attempt's branch into a fresh worktree's HEAD (the current main) and
// leaves it uncommitted, for the next attempt to finish. Where both sides changed the same lines, the files
// hold conflict markers (zdiff3: main's side, the common base, then the kept work's); manifests and lockfiles
// are resolved as in a rebase. `conflicts` lists the files still in conflict and `messages` git's account
// of them. When nothing is carried the worktree is left as it was, clean.
export async function carryInto(worktree: string, kept: string, fix: Partial<Resolvers>): Promise<CarryResult> {
  const resolvers = { relock: fix.relock ?? {}, jsonMerge: fix.jsonMerge ?? {} };
  try {
    if (!(await gitOk(worktree, 'rev-parse', '--verify', '--quiet', `refs/heads/${kept}^{commit}`))) return { ok: false, why: `branch ${kept} no longer exists` };
    const args = ['-c', 'merge.conflictStyle=zdiff3', '-c', 'core.quotePath=false', 'merge-tree', '--write-tree', 'HEAD', kept];
    // Exit 1 is a merge with conflicts; the result is written all the same.
    const out = await exec('git', args, { cwd: worktree, maxBuffer: 64 * 1024 * 1024 }).then(
      (r) => r.stdout,
      (e: { code?: number; stdout?: string; stderr?: string }) => (e.code === 1 && e.stdout ? e.stdout : new Error(`${e.stderr ?? e}`.trim())),
    );
    if (out instanceof Error) return { ok: false, why: `git merge-tree failed: ${out.message}` };
    const [info = '', ...rest] = out.split('\n\n');
    const [tree = '', ...stageLines] = info.trim().split('\n');
    if (tree === (await git(worktree, 'rev-parse', 'HEAD^{tree}'))) return { ok: false, why: `main already holds everything on ${kept}` };
    const stages = new Map<string, Partial<Record<1 | 2 | 3, string>>>();
    for (const l of stageLines) {
      const m = /^\d+ ([0-9a-f]+) ([123])\t(.+)$/.exec(l);
      if (m) stages.set(m[3]!, { ...stages.get(m[3]!), [Number(m[2])]: m[1] });
    }
    await git(worktree, 'read-tree', '-u', '-m', 'HEAD', tree);
    await git(worktree, 'reset', '--quiet'); // uncommitted and unstaged, as the agent's own work in progress
    const conflicted = [...stages.keys()];
    const left = await resolveDependencyFiles(worktree, resolvers, conflicted, (f, n) => stages.get(f)?.[n]);
    // A manifest or lockfile that could not be resolved goes back to what the merge left, markers and all.
    for (const f of left.filter((f) => isManifest(resolvers, f) || isLockfile(resolvers, f))) {
      const merged = await blob(worktree, `${tree}:${f}`);
      if (merged !== undefined) writeFileSync(join(worktree, f), merged);
    }
    const resolved = conflicted.filter((f) => !left.includes(f));
    const messages = rest.join('\n\n').split('\n').filter((l) => l.startsWith('CONFLICT') && !resolved.some((f) => l.includes(f)));
    return { ok: true, conflicts: left, messages, resolved };
  } catch (e) {
    await gitOk(worktree, 'reset', '--quiet', '--hard');
    await gitOk(worktree, 'clean', '-ffdq');
    return { ok: false, why: `the merge failed: ${(e as Error).message.split('\n')[0]}` };
  }
}

// gitleaks' verbose report holds one block per finding; each block's rule, file and line, in that order.
// The secret itself is never read: the scan runs with --redact.
export function secretFindings(report: string): { rule: string; file: string; line: string }[] {
  const out: { rule: string; file: string; line: string }[] = [];
  let rule = '';
  let file = '';
  for (const l of report.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const m = /^(RuleID|File|Line):\s+(.*)$/.exec(l.trim());
    if (m?.[1] === 'RuleID') rule = m[2]!;
    else if (m?.[1] === 'File') file = m[2]!;
    else if (m?.[1] === 'Line') out.push({ rule, file, line: m[2]! });
  }
  return out;
}
