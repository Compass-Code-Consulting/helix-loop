import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gitAuthor, repoDir, type Config, type Paths } from './config.ts';
import { git, gitNet, gitNetOk, hasRemote, head } from './git.ts';
import { readLedger, record } from './ledger.ts';
import { compareWithOrigin } from './merge.ts';
import type { HumanTask, RepoName } from './types.ts';

// Release tags (Compass & Code's convention): v<YYYY>.<MM>.<DD>.<N>, annotated, where N counts that
// day's releases of the repo from 1. A release is cut every `every_merged_tasks` merges, in each lane a
// milestone touched when it is reached, and on `helix-loop release run <repo>`; all three go through
// releaseRepo, with the same holds. A tag is what deploys: today straight to production; later the
// same tag promotes through test, then staging, then production.
//
// Production's secrets reach whatever a v* tag runs: the workflows and actions under .github/, and the
// OpenTofu code under infra/ that the deploy job applies (release.review_paths). The loop never tags a
// release that changes those since the previous release (or the root commit). It writes
// runs/approvals/<repo>-<tag>.json instead, and `helix-loop release approve` tags exactly that commit
// once the owner has read the diff. Later releases of the repo wait behind it, because each would carry
// the same unreviewed change.

export interface Approval {
  repo: string;
  tag: string;
  commit: string; // what the tag will point at: main when the release was due
  since: string; // the previous release tag, or the root commit when there is none
  paths: string[]; // files under the review paths that differ between `since` and `commit`
  review: string; // the command that shows their diff
  approve: string; // the command that tags and pushes, run from the control plane
  reason: string;
  tasks: { id: string; title: string }[];
  requestedAt: string;
}

// What a repo's releases need from the config: where things are, and its holds.
export interface ReleaseSettings {
  repo: string; // the repo's name
  dir: string; // its primary checkout, on main
  approvals: string; // runs/approvals
  ledger: string;
  push: boolean;
  reviewPaths: string[];
  holdUntil?: string; // the human task its releases wait for
}

export function releaseSettings(config: Config, p: Paths, repo: string): ReleaseSettings {
  return {
    repo,
    dir: repoDir(config, repo),
    approvals: p.approvals,
    ledger: p.ledger,
    push: config.push,
    reviewPaths: config.release.review_paths,
    holdUntil: config.release.hold_until?.[repo as RepoName],
  };
}

export interface ReleaseRequest extends ReleaseSettings {
  human: Map<string, HumanTask>;
  now: number;
  reason: string;
  tasks: { id: string; title: string }[]; // merged since the last release, oldest first
}

type Retried = { tags: string[]; pushed: boolean };
export type ReleaseOutcome = { retried?: Retried } & (
  | { kind: 'tagged'; tag: string; commit: string; pushed: boolean | 'skipped' }
  | { kind: 'current'; tag: string; commit: string } // main is already released
  | {
      kind: 'held';
      detail: string; // why, as the ledger records it
      clears: string; // what a person does to lift the hold, as an instruction
      diverged?: string;
      approval?: { approval: Approval; file: string; requested: boolean }; // requested: written just now
    }
);

// The day's highest N plus one, so a missing tag in the sequence can never make the next name collide.
export function releaseTagName(existing: string[], now: number): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const n = Math.max(0, ...existing.filter((t) => t.startsWith(`v${day}.`)).map((t) => Number(t.slice(day.length + 2)) || 0)) + 1;
  return `v${day}.${n}`;
}

// Tasks merged into a repo that no release has carried yet, oldest first. Each release lists what it
// carries, so a release approved after more merges (release approve) leaves those merges unreleased.
export function unreleased(ledgerFile: string, repo: string): string[] {
  let pending: string[] = [];
  for (const e of readLedger(ledgerFile)) {
    if (e.kind === 'merge' && e.repo === repo) pending.push(e.task);
    if (e.kind === 'release' && e.repo === repo) {
      const carried = new Set(e.tasks);
      pending = pending.filter((id) => !carried.has(id));
    }
  }
  return pending;
}

const approvalFile = (dir: string, repo: string, tag: string) => join(dir, `${repo}-${tag}.json`);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const listed = (paths: string[]) => (paths.length > 4 ? `${paths.slice(0, 4).join(', ')} and ${paths.length - 4} more` : paths.join(', '));

// An approval's `since` for people: the previous release tag, or the root commit.
export const describeBase = (since: string) => (/^[0-9a-f]{40}$/.test(since) ? `the root commit (${since.slice(0, 12)})` : since);

// Every waiting approval, or one repo's (by file name, so a damaged file holds only its own repo).
export function pendingApprovals(dir: string, repo?: string): { file: string; approval: Approval }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && (!repo || f.startsWith(`${repo}-v`)))
    .sort()
    .map((f) => ({ file: join(dir, f), approval: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Approval }));
}

// The latest release tag in `commit`'s history, or the root commit when the repo has never released.
async function previousRelease(dir: string, commit: string): Promise<string> {
  const tags = await git(dir, 'tag', '--list', 'v*', '--merged', commit, '--sort=-v:refname');
  if (tags) return tags.split('\n')[0]!;
  return (await git(dir, 'rev-list', '--max-parents=0', commit)).split('\n').pop()!;
}

// Release tags origin does not have, because their push failed, pushed again. Only v* tags, and only
// what origin can be seen to lack; the attempt is recorded.
export async function retryTagPushes(s: Pick<ReleaseSettings, 'repo' | 'dir' | 'ledger'>, now: number): Promise<Retried | undefined> {
  if (!(await hasRemote(s.dir))) return undefined;
  const local = (await git(s.dir, 'tag', '--list', 'v*')).split('\n').filter(Boolean);
  if (!local.length) return undefined;
  const remote = await gitNet(s.dir, 'ls-remote', '--tags', '--refs', 'origin');
  if (remote === null) return undefined; // origin unreachable: next time
  const there = new Set(remote.split('\n').map((l) => l.split('\t')[1]?.replace(/^refs\/tags\//, '')));
  const tags = local.filter((t) => !there.has(t));
  if (!tags.length) return undefined;
  const pushed = await gitNetOk(s.dir, 'push', '--quiet', 'origin', ...tags.map((t) => `refs/tags/${t}`));
  record(s.ledger, { kind: 'release_retry', at: new Date(now).toISOString(), repo: s.repo, tags, pushed });
  return { tags, pushed };
}

// Cuts a release of the repo's main, or records why it is held and returns what lifts the hold.
export async function releaseRepo(r: ReleaseRequest): Promise<ReleaseOutcome> {
  let retried: Retried | undefined;
  const held = (detail: string, clears: string, more: { diverged?: string; approval?: { approval: Approval; file: string; requested: boolean } } = {}): ReleaseOutcome => {
    const a = more.approval;
    const extra = a ? { tag: a.approval.tag, approval: join('runs', 'approvals', basename(a.file)) } : {};
    record(r.ledger, { kind: 'release_held', at: new Date(r.now).toISOString(), repo: r.repo, reason: r.reason, tasks: r.tasks.map((t) => t.id), detail, ...extra });
    return { kind: 'held', detail, clears, ...more, retried };
  };

  // A tag pushed into a repo whose main has diverged would republish commits origin no longer has.
  if (r.push) {
    const origin = await compareWithOrigin(r.dir);
    if (origin.relation === 'diverged') return held(`while ${origin.detail}`, `reconcile main with origin/main in repos/${r.repo}`, { diverged: origin.detail });
    retried = await retryTagPushes(r, r.now);
  }
  if (r.holdUntil) {
    const step = r.human.get(r.holdUntil);
    if (step?.status !== 'done') {
      return held(`until ${r.holdUntil} is done (${step ? `it is ${step.status}` : 'it is not in the plan'})`, `mark ${r.holdUntil} done in plan/human/${r.holdUntil}.yaml once it is`);
    }
  }
  const commit = await head(r.dir, 'main');
  const [current] = (await git(r.dir, 'tag', '--list', 'v*', '--points-at', commit, '--sort=-v:refname')).split('\n').filter(Boolean);
  if (current) return { kind: 'current', tag: current, commit, retried };

  const [waiting] = pendingApprovals(r.approvals, r.repo);
  if (waiting) {
    const { tag, paths, review, approve } = waiting.approval;
    return held(`behind ${tag}, which waits for approval of its changes to ${listed(paths)}`, `read the diff with ${review}, then run ${approve}`, {
      approval: { ...waiting, requested: false },
    });
  }
  const tag = releaseTagName((await git(r.dir, 'tag', '--list', 'v*')).split('\n').filter(Boolean), r.now);
  const since = await previousRelease(r.dir, commit);
  const specs = r.reviewPaths.map((g) => `:(glob)${g}`);
  const changed = await git(r.dir, 'diff', '--name-only', '--no-renames', since, commit, '--', ...specs);
  if (changed) {
    const approval: Approval = {
      repo: r.repo,
      tag,
      commit,
      since,
      paths: changed.split('\n'),
      review: `git -C ${quote(r.dir)} diff ${since} ${commit} -- ${specs.map(quote).join(' ')}`,
      approve: `helix-loop release approve ${r.repo} ${tag}`,
      reason: r.reason,
      tasks: r.tasks,
      requestedAt: new Date(r.now).toISOString(),
    };
    const file = approvalFile(r.approvals, r.repo, tag);
    mkdirSync(r.approvals, { recursive: true });
    writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
    return held(`for approval: ${tag} changes ${listed(approval.paths)} since ${describeBase(since)}`, `read the diff with ${approval.review}, then run ${approval.approve}`, {
      approval: { approval, file, requested: true },
    });
  }
  await createTag(r.dir, tag, commit, r.reason, r.tasks);
  const pushed = await pushTag(r.dir, tag, r.push);
  record(r.ledger, { kind: 'release', at: new Date(r.now).toISOString(), repo: r.repo, tag, tasks: r.tasks.map((t) => t.id), reason: r.reason, pushed });
  return { kind: 'tagged', tag, commit, pushed, retried };
}

async function createTag(dir: string, tag: string, commit: string, reason: string, tasks: { id: string; title: string }[]): Promise<void> {
  const body = tasks.map((t) => `- ${t.id} ${t.title}`).join('\n');
  const message = `Release ${tag}\n\n${reason}: ${tasks.length} task${tasks.length === 1 ? '' : 's'}.\n\n${body}`;
  await git(dir, ...gitAuthor(), 'tag', '-a', tag, '-m', message, commit);
}

async function pushTag(dir: string, tag: string, push: boolean): Promise<boolean | 'skipped'> {
  if (!push || !(await hasRemote(dir))) return 'skipped';
  return gitNetOk(dir, 'push', '--quiet', 'origin', `refs/tags/${tag}`);
}

export interface ApproveInput {
  repo: string; // the repo's name
  dir: string; // its primary checkout
  tag: string;
  approvals: string;
  ledger: string;
  push: boolean;
  now: number;
}

// `helix-loop release approve`: tags exactly the reviewed commit with exactly the recorded name, pushes
// it, records the release, and removes the approval. A push that fails is retried like any release
// tag's: before the repo's next release, and when the loop starts.
export async function approveRelease(input: ApproveInput): Promise<{ approval: Approval; pushed: boolean | 'skipped' }> {
  const file = approvalFile(input.approvals, input.repo, input.tag);
  if (!existsSync(file)) {
    const pending = pendingApprovals(input.approvals).map((a) => `${a.approval.repo} ${a.approval.tag}`);
    throw new Error(`No release of ${input.repo} waits for approval as ${input.tag}. Waiting: ${pending.join(', ') || 'none'}.`);
  }
  const approval = JSON.parse(readFileSync(file, 'utf8')) as Approval;
  const existing = (await git(input.dir, 'tag', '--list', input.tag)) ? await head(input.dir, `${input.tag}^{commit}`) : undefined;
  if (existing && existing !== approval.commit) {
    throw new Error(`${input.tag} already exists in ${input.repo} at ${existing.slice(0, 12)}, not at the reviewed ${approval.commit.slice(0, 12)}; nothing was tagged.`);
  }
  const reason = `${approval.reason} (approved after review)`;
  if (!existing) await createTag(input.dir, input.tag, approval.commit, reason, approval.tasks);
  const pushed = await pushTag(input.dir, input.tag, input.push);
  // Recorded before the approval goes, so the loop never sees the release as neither waiting nor made.
  record(input.ledger, { kind: 'release', at: new Date(input.now).toISOString(), repo: input.repo, tag: input.tag, tasks: approval.tasks.map((t) => t.id), reason, pushed });
  rmSync(file);
  return { approval, pushed };
}
