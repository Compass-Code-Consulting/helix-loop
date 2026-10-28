import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadConfig, logFile, paths } from '../config.ts';
import { git } from '../git.ts';
import type { LedgerEvent } from '../ledger.ts';
import { loadPlan } from '../plan/store.ts';
import type { HumanTask, Plan } from '../types.ts';
import { runningTasks } from '../app/actions.ts';
import { dependentsOf, downstream, type Board } from '../app/board.ts';
import { undoChange, type Change } from '../app/changes.ts';
import { applyChanges, applyRecorded } from '../app/fixes.ts';
import { readReads } from '../app/helix.ts';
import type { PlanChange } from '../app/incidents.ts';
import { loopStatus, passesNow, readReports, snapshot, type PassNow, type Snapshot } from '../app/state.ts';
import { readEntries, threadsOf } from '../app/threads.ts';
import { builderHistory, buildView, taskCommits, type View } from '../app/views.ts';
import { OpError, type Actor } from './actor.ts';

// The plan's direct actions: handing tasks back and parking them, their dependencies and notes, the owner's own
// human tasks, and undo. Each change is one validated commit and one entry in the undo list (app/changes.ts).

export interface Applied {
  change?: Change; // absent when nothing changed, or the project is not a git checkout
  created: string[];
  tasks: string[];
}

const fresh = (root: string): Plan => loadPlan(paths(root).tasks, paths(root).human);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- tasks ----

// Hand tasks back to the loop (ready), or park them, with a note for their next builder. Tasks the plan lacks
// are refused, unless `skipUnknown` (a group on Home whose members moved on meanwhile).
export async function setStatus(root: string, ids: string[], op: 'hand_back' | 'park', o: { note?: string; actor: Actor; source?: string; skipUnknown?: boolean }): Promise<Applied> {
  const plan = fresh(root);
  const known = o.skipUnknown ? ids.filter((id) => plan.tasks.has(id)) : ids;
  const note = o.note?.trim() || undefined;
  const changes: PlanChange[] = known.map((task) => ({ op, task, note }));
  const what = known.length === 1 ? `${known[0]} ${op === 'park' ? 'parked' : 'handed back to the loop'}` : `${op === 'park' ? 'park' : 'hand back'} ${plural(known.length, 'task')}`;
  return applyChanges(root, changes, { what, by: o.actor.by, where: o.actor.where, source: o.source });
}

export async function setDep(root: string, id: string, on: string, add: boolean, actor: Actor): Promise<Applied> {
  const t = fresh(root).tasks.get(id);
  if (!t) throw new OpError(404, `no task ${id}`);
  if (add && t.blocked_by.includes(on)) throw new OpError(409, `${id} waits on ${on} already`);
  if (!add && !t.blocked_by.includes(on)) throw new OpError(409, `${id} doesn't wait on ${on}`);
  return applyChanges(root, [{ op: add ? 'add_dep' : 'remove_dep', task: id, on }], { what: `${id} ${add ? 'waits on' : 'no longer waits on'} ${on}`, by: actor.by, where: actor.where });
}

// A note for a task's next attempt (spec §6.5): into its notes now, or, while its pass runs and the loop holds the
// task, queued until the pass ends (landNotes).
export const pendingNotesFile = (root: string) => join(paths(root).runs, 'pending-notes.jsonl');

export async function addNote(root: string, task: string, note: string, actor: Actor): Promise<{ pending: true } | (Applied & { pending?: undefined })> {
  const text = note.trim().slice(0, 2000);
  if (!text) throw new OpError(400, 'write the note first');
  const plan = fresh(root);
  if (!plan.tasks.has(task)) throw new OpError(404, `no task ${task}`);
  if (runningTasks(root, plan).has(task)) {
    mkdirSync(paths(root).runs, { recursive: true });
    appendFileSync(pendingNotesFile(root), `${JSON.stringify({ at: new Date().toISOString(), task, note: text })}\n`);
    return { pending: true };
  }
  return noteNow(root, task, text, actor);
}

const noteNow = (root: string, task: string, note: string, actor: Actor) => applyChanges(root, [{ op: 'note', task, note }], { what: `${task} note for its next attempt`, by: actor.by, where: actor.where });

interface Pending {
  at: string;
  task: string;
  note: string;
}
const readPending = (file: string): Pending[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try {
    return [JSON.parse(l) as Pending];
  } catch {
    return []; // a line mid-append
  }
}) : []);

// Lands the queued notes whose pass has ended. The app does this as it sees the plan change, the CLI on the
// commands that read tasks; the file is claimed by renaming it first, so the two never land a note twice.
export async function landNotes(root: string, actor: Actor): Promise<{ landed: string[]; failed: { task: string; error: string }[] }> {
  const file = pendingNotesFile(root);
  const none = { landed: [], failed: [] };
  if (!existsSync(file)) return none;
  const busy = runningTasks(root, snapshot(root).plan);
  if (readPending(file).every((n) => busy.has(n.task))) return none;
  const claimed = `${file}.${process.pid}`;
  try {
    renameSync(file, claimed);
  } catch {
    return none; // another process claimed it first
  }
  const all = readPending(claimed);
  rmSync(claimed, { force: true });
  const left = all.filter((n) => busy.has(n.task));
  if (left.length) appendFileSync(file, left.map((n) => `${JSON.stringify(n)}\n`).join(''));
  const out: { landed: string[]; failed: { task: string; error: string }[] } = { landed: [], failed: [] };
  for (const n of all.filter((x) => !busy.has(x.task))) {
    if (!fresh(root).tasks.has(n.task)) continue;
    try {
      await noteNow(root, n.task, n.note, actor);
      out.landed.push(n.task);
    } catch (e) {
      out.failed.push({ task: n.task, error: (e as Error).message });
    }
  }
  return out;
}

// A task's notes (its next builder reads them in its prompt) or a human task's, replaced whole.
export async function setNotes(root: string, id: string, notes: string, actor: Actor): Promise<Applied> {
  const text = notes.trim();
  if (text.length > 6000) throw new OpError(400, 'notes are at most 6,000 characters');
  const plan = fresh(root);
  if (!plan.tasks.has(id) && !plan.human.has(id)) throw new OpError(404, `no task ${id}`);
  const batch = plan.human.has(id) ? { human: [{ id, patch: { notes: text } }] } : { tasks: [{ id, patch: { notes: text } }] };
  return applyRecorded(root, batch, { what: `${id} notes ${text ? 'updated' : 'cleared'}`, by: actor.by, where: actor.where });
}

export const undo = (root: string, id: string, actor: Actor) => undoChange(root, id, Date.now(), actor);

// ---- the owner's human tasks ----

export interface HumanChange {
  status?: string;
  steps?: number[]; // the checklist's ticked steps, numbered from 1
  snooze?: string; // a date (YYYY-MM-DD...); '' takes the snooze off
  evidence?: string; // what shows it done
}

export async function humanAction(root: string, id: string, a: HumanChange, actor: Actor): Promise<{ value: HumanTask; change?: Change }> {
  const h = fresh(root).human.get(id);
  if (!h) throw new OpError(404, `no human task ${id}`);
  const patch: Partial<HumanTask> = {};
  if (a.status !== undefined) {
    if (!['todo', 'in_progress', 'done'].includes(a.status)) throw new OpError(400, 'status is todo, in_progress or done');
    patch.status = a.status as HumanTask['status'];
  }
  let notes = h.notes ?? '';
  // The checklist's ticks, kept as one line of the notes.
  if (a.steps) {
    const done = a.steps.map(Number).filter((n) => n > 0).sort((x, y) => x - y);
    notes = [done.length ? `Steps done: ${done.join(', ')}` : '', notes.replace(/^Steps done:.*$\n?/m, '').trim()].filter(Boolean).join('\n');
  }
  if (a.snooze !== undefined) {
    notes = [a.snooze ? `Snoozed until ${a.snooze.slice(0, 10)}` : '', notes.replace(/^Snoozed until .*$\n?/m, '').trim()].filter(Boolean).join('\n');
  }
  if (a.evidence?.trim()) notes = [notes, `Evidence (${new Date().toISOString().slice(0, 10)}): ${a.evidence.trim().slice(0, 1000)}`].filter(Boolean).join('\n');
  if (notes !== (h.notes ?? '')) patch.notes = notes;
  if (!Object.keys(patch).length) return { value: h };
  const what = patch.status ? patch.status.replace('_', ' ') : a.snooze !== undefined ? (a.snooze ? `snoozed until ${a.snooze.slice(0, 10)}` : 'unsnoozed') : 'checklist updated';
  const r = await applyRecorded(root, { human: [{ id, patch }] }, { what: `${id} ${what}`, by: actor.by, where: actor.where });
  return { value: { ...h, ...patch }, change: r.change };
}

// A human task's steps: the numbered lines under "Steps:" in its handoff prompt.
export function stepsOf(h: HumanTask): string[] {
  const p = h.handoff_prompt ?? '';
  const at = p.search(/^Steps:\s*$/m);
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of p.slice(at).split('\n').slice(1)) {
    const m = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) out.push(m[2]!.trim());
    else if (out.length && line.trim() === '') break;
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}
export const doneSteps = (h: HumanTask) => (/^Steps done: (.*)$/m.exec(h.notes ?? '')?.[1] ?? '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
export const snoozedUntil = (h: HumanTask) => /^Snoozed until (\S+)$/m.exec(h.notes ?? '')?.[1];

// A human task as its checklist shows it: where it stands on the board, its steps, and what waits on it.
export function humanCard(plan: Plan, board: Board, id: string) {
  const h = plan.human.get(id);
  if (!h) throw new OpError(404, `no human task ${id}`);
  const b = board.human.find((x) => x.id === id);
  const waiting = [...[...plan.tasks.values()].filter((t) => t.blocked_by.includes(h.id) && t.status !== 'done'), ...[...plan.human.values()].filter((x) => x.blocked_by.includes(h.id) && x.status !== 'done')];
  // The milestones its wait holds back: those with open work behind it, directly or not, in delivery order.
  const behind = downstream(plan, dependentsOf(plan), h.id);
  const holdsBack = h.status === 'done' ? [] : board.milestones.filter((m) => m.tasks.some((id) => behind.has(id))).map((m) => ({ key: m.key, title: m.title, n: board.milestones.indexOf(m) + 1 }));
  const serves = h.story ? plan.taskset?.stories.get(h.story)?.title : undefined;
  return { ...h, held: b?.held ?? 0, late: b?.late ?? false, latestStart: b?.latestStart, critical: b?.critical ?? false, steps: stepsOf(h), done: doneSteps(h), unblocks: waiting.map((t) => ({ id: t.id, title: t.title, status: t.status })), holdsBack, ...(serves ? { serves } : {}) };
}

// ---- a task's whole story ----

// The passes in flight, each with its builder's latest progress report and Helix's read of it.
export function livePasses(root: string, plan: Plan, events: LedgerEvent[]): (PassNow & { progress?: string; progressAt?: string; helix?: string })[] {
  const reports = readReports(root);
  const reads = readReads(root);
  return passesNow(root, plan, loopStatus(root, events)).map((x) => {
    const last = reports.findLast((r) => r.pass === x.id && r.kind === 'progress');
    return { ...x, progress: last?.message, progressAt: last?.at, helix: reads.get(x.task)?.text };
  });
}

// Everything about one task or human task: its state, where it sits, its builders' attempts, what it cost, its
// commits once merged, what waits on it, and its threads. The app passes what it has cached.
export async function taskStory(root: string, id: string, c: { snap?: Snapshot; view?: View; live?: ReturnType<typeof livePasses> } = {}) {
  const snap = c.snap ?? snapshot(root);
  const { plan, events } = snap;
  const task = plan.tasks.get(id);
  const human = plan.human.get(id);
  if (!task && !human) throw new OpError(404, `no task ${id}`);
  const v = c.view ?? buildView(root, snap, loadConfig(root), { dismissed: new Set() });
  const dir = paths(root).threads;
  const targets = [id, ...(task?.blocked_by ?? human?.blocked_by ?? []).map((d) => `${id}~${d}`)];
  const live = (c.live ?? livePasses(root, plan, events)).find((p) => p.task === id);
  const passes = events.filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.task === id);
  return {
    task,
    human: human && { ...human, steps: stepsOf(human), done: doneSteps(human) },
    board: v.board.tasks.find((t) => t.id === id) ?? v.board.human.find((h) => h.id === id),
    trail: task || human?.story ? trailItems(v.board, task ? v.board.tasks.find((t) => t.id === id)!.story : `story:${human!.story}`) : [],
    milestone: task ? v.board.milestones.find((m) => m.tasks.includes(id)) : undefined,
    wiredBy: task ? [...plan.tasks.values()].filter((t) => t.wires?.includes(id)).map((t) => ({ id: t.id, title: t.title, status: t.status })) : [],
    running: runningTasks(root, plan).has(id),
    live,
    reports: readReports(root).filter((r) => r.task === id).slice(-30),
    history: task ? builderHistory(plan, events, id, live) : [],
    commits: task?.status === 'done' ? await taskCommits(root, events, id) : undefined,
    merged: events.findLast((e): e is Extract<LedgerEvent, { kind: 'merge' }> => e.kind === 'merge' && e.task === id),
    cost: { usd: passes.reduce((n, e) => n + e.costUsd, 0), ms: passes.reduce((n, e) => n + e.durationMs, 0), passes: passes.length },
    remote: task ? await remoteUrl(root, task.repo) : undefined,
    unblocks: [...plan.tasks.values()].filter((t) => t.blocked_by.includes(id)).map((t) => ({ id: t.id, title: t.title, status: t.status })),
    threads: Object.fromEntries(targets.map((t) => [t, threadsOf(t, readEntries(dir, t))])),
  };
}

// Where an item sits: its lane, epic, feature and story, outermost first, as the board names them.
export function trailItems(board: Board, itemId: string): { id: string; level: string; key: string; title: string }[] {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const out = [];
  for (let i = byId.get(itemId); i; i = i.parent ? byId.get(i.parent) : undefined) out.unshift({ id: i.id, level: i.level, key: i.key, title: i.title });
  return out;
}

export async function remoteUrl(root: string, repo: string): Promise<string | undefined> {
  const u = await git(join(paths(root).repos, repo), 'remote', 'get-url', 'origin').catch(() => '');
  const slug = /github\.com[:/](.+?)(\.git)?$/.exec(u)?.[1];
  return slug ? `https://github.com/${slug}` : undefined;
}

// ---- pass logs ----

// A pass's log, as the ledger and the plan name it: runs/logs/<day>/<task>-<agent>-<n>.log, gzipped once the
// pass has ended.
export function logPath(rel: string): string {
  const clean = normalize(rel);
  if (!/^runs\/logs\/[\w./-]+\.log(\.gz)?$/.test(clean) || clean.includes('..')) throw new OpError(400, 'not a pass log');
  return clean;
}

// The log's file as it is now: the running pass's, or the finished pass's compressed one.
export function logOnDisk(root: string, rel: string): string | undefined {
  const clean = logPath(rel);
  return [logFile(root, clean), logFile(root, clean.endsWith('.gz') ? clean : `${clean}.gz`), logFile(root, clean.replace(/\.gz$/, ''))].find((f) => existsSync(f));
}

export function readLog(root: string, rel: string): string {
  const file = logOnDisk(root, rel);
  if (!file) throw new OpError(404, 'that log is gone');
  const buf = readFileSync(file);
  const s = (file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
  return s.length > 2_000_000 ? `… (the first ${s.length - 2_000_000} characters are left out)\n${s.slice(-2_000_000)}` : s;
}

// The end of a pass log's gate output: from its last gate run, without the builder's event lines.
export function gateTail(root: string, rel: string, lines = 40): string {
  let s: string;
  try {
    s = readLog(root, rel);
  } catch {
    return '';
  }
  const at = s.lastIndexOf('> gate ');
  return (at >= 0 ? s.slice(at) : s).split('\n').filter((l) => !l.startsWith('{')).slice(-lines).join('\n').slice(-4000);
}
