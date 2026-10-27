import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { paths } from '../config.ts';
import { loadPlan } from '../plan/store.ts';
import type { Task } from '../types.ts';
import { applyBatch, commit, PlanEditError, type Batch } from './actions.ts';
import { recordChange, type Change } from './changes.ts';
import type { PlanChange } from './incidents.ts';
import { ownerOf } from './prompts.ts';

// Applying plan changes as one: a fix the owner accepts or Helix applies, a batch action on Home, an answer sent to a
// group of tasks. Each becomes one validated commit and one entry in the undo list.

export const BATCH_FIELDS = ['status', 'notes', 'blocked_by'] as const;
const NEW_TASK_FIELDS = ['repo', 'stage', 'area', 'feature', 'epic', 'title', 'reqs', 'spec', 'acceptance', 'blocked_by', 'estimate_passes', 'priority', 'agent', 'notes'];

// A note goes under what the task's notes already say, so the next builder reads both.
export const withNote = (t: Task | undefined, note?: string) => (note?.trim() ? [t?.notes?.trim(), note.trim()].filter(Boolean).join('\n\n') : t?.notes);

export function toBatch(root: string, changes: PlanChange[]): { batch: Batch; pause: boolean } {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const patches = new Map<string, Partial<Task>>();
  const patch = (id: string) => {
    let x = patches.get(id);
    if (!x) patches.set(id, (x = {}));
    return x;
  };
  const current = (id: string): Task | undefined => {
    const t = plan.tasks.get(id);
    return t && { ...t, ...patches.get(id) };
  };
  const create: Batch['create'] = [];
  let pause = false;
  for (const c of changes) {
    if (c.op === 'pause') pause = true;
    else if (c.op === 'new_task') {
      const task = Object.fromEntries(Object.entries(c.task).filter(([k]) => NEW_TASK_FIELDS.includes(k))) as Partial<Task>;
      create.push({ ref: c.ref, task });
    } else {
      const t = current(c.task);
      if (!t) throw new PlanEditError(`no task ${c.task}`);
      if (c.op === 'hand_back') Object.assign(patch(c.task), { status: 'ready', notes: withNote(t, c.note) });
      else if (c.op === 'park') Object.assign(patch(c.task), { status: 'parked', notes: withNote(t, c.note) });
      else if (c.op === 'note') Object.assign(patch(c.task), { notes: withNote(t, c.note) });
      else if (c.op === 'add_dep') patch(c.task).blocked_by = [...new Set([...t.blocked_by, c.on])];
      else if (c.op === 'remove_dep') patch(c.task).blocked_by = t.blocked_by.filter((d) => d !== c.on);
    }
  }
  // A patch that sets a status the task already has changes nothing: leave the status out.
  const tasks = [...patches].map(([id, x]) => {
    if (x.status && plan.tasks.get(id)?.status === x.status) delete x.status;
    if (x.notes === plan.tasks.get(id)?.notes) delete x.notes;
    return { id, patch: x };
  }).filter((x) => Object.keys(x.patch).length);
  return { batch: { tasks, create }, pause };
}

// Applies plan changes as one commit, records them for undo, and says what changed.
export async function applyChanges(root: string, changes: PlanChange[], opts: { what: string; by: string; source?: string }): Promise<{ change?: Change; created: string[]; tasks: string[] }> {
  const { batch, pause } = toBatch(root, changes);
  if (pause) {
    mkdirSync(dirname(paths(root).pause), { recursive: true });
    writeFileSync(paths(root).pause, `paused by ${opts.by}: ${opts.what}\n`);
  }
  if (!batch.tasks?.length && !batch.create?.length) return { created: [], tasks: [] };
  // The commit says what and who; where it came from (a group, a fix, a request) is kept in the undo record.
  const r = await applyBatch(root, batch, { fields: BATCH_FIELDS, message: `Plan: ${opts.what} (${opts.by}, in Helix Loop)` });
  const files = r.value.tasks.map((id) => relative(root, `${paths(root).tasks}/${id}.yaml`));
  const change = r.commit ? recordChange(root, { by: opts.by, what: opts.what, commit: r.commit, files, tasks: r.value.tasks, source: opts.source }) : undefined;
  return { change, created: r.value.created, tasks: r.value.tasks };
}

// Answer once (spec §6.3): a numbered clarification in spec/clarifications.md, for the loop engineer to fold into
// the spec with its changelog row. Never the spec's own sections.
export async function addClarification(root: string, about: string, text: string, tasks: string[]): Promise<string> {
  const file = paths(root).clarifications;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : `# Clarifications\n\nAnswers ${ownerOf(root)} sent from Helix Loop, numbered per requirement. The loop engineer folds each into the spec with an Appendix B row, then deletes it here.\n`;
  const n = (existing.match(new RegExp(`^## ${about.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)`, 'gm')) ?? []).length + 1;
  const id = `${about}.${n}`;
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, existing);
  appendFileSync(file, `\n## ${id}\n\n${text.trim().split(/(?<=[.!?])\s+/).join('\n')}\n\nAsked by ${tasks.join(', ')}; answered ${new Date().toISOString().slice(0, 10)}.\n`);
  if (existsSync(`${root}/.git`)) await commit(root, [relative(root, file)], `Spec: clarification ${id} (${ownerOf(root)}, in Helix Loop)`).catch(() => false);
  return id;
}
