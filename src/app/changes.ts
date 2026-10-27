import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { paths } from '../config.ts';
import { atomicWrite, loadPlan } from '../plan/store.ts';
import { afterEdit, PlanEditError, runningTasks } from './actions.ts';
import { ownerOf } from './prompts.ts';

// Every plan change the app applies, by the owner or by Helix, is recorded with the commit that made it
// (runs/changes.jsonl), so that for a day it can be undone (spec §8.1): the changed task files go back to what
// they were before it, as a new commit. An undo is refused when something later changed one of those files
// (the loop's own passes included), or when one of its tasks is in a pass.

const exec = promisify(execFile);
export const UNDO_MS = 24 * 3_600_000;

export interface Change {
  id: string; // C-1
  at: string;
  by: string; // "the owner" or "Helix monitor"
  what: string; // one line
  commit: string;
  files: string[]; // relative to the root: the plan files it changed
  tasks: string[];
  source?: string; // the group, incident, fix or record it came from
}

type Entry = ({ type: 'applied' } & Change) | { type: 'undone'; id: string; at: string; commit?: string };

export function readChanges(file: string): (Change & { undone?: string })[] {
  if (!existsSync(file)) return [];
  const out: (Change & { undone?: string })[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const e = JSON.parse(l) as Entry;
      if (e.type === 'applied') {
        const { type: _t, ...c } = e;
        out.push(c);
      } else {
        const c = out.find((x) => x.id === e.id);
        if (c) c.undone = e.at;
      }
    } catch {
      // a line mid-append
    }
  }
  return out;
}

function append(file: string, e: Entry): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(e)}\n`);
}

export function recordChange(root: string, c: Omit<Change, 'id' | 'at'>): Change {
  const file = paths(root).changes;
  const change: Change = { id: `C-${readChanges(file).length + 1}`, at: new Date().toISOString(), ...c };
  append(file, { type: 'applied', ...change });
  return change;
}

export async function undoChange(root: string, id: string, now = Date.now()): Promise<{ commit?: string }> {
  const file = paths(root).changes;
  const c = readChanges(file).find((x) => x.id === id);
  if (!c) throw new PlanEditError(`no change ${id}`);
  if (c.undone) throw new PlanEditError(`${id} was undone already`);
  if (now - Date.parse(c.at) > UNDO_MS) throw new PlanEditError(`${id} is more than a day old; change the plan directly instead`);
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const busy = c.tasks.filter((t) => runningTasks(root, plan).has(t));
  if (busy.length) throw new PlanEditError(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} in a pass; undo once ${busy.length === 1 ? 'it ends' : 'they end'}`);
  const later = (await exec('git', ['log', '--format=%h %s', `${c.commit}..HEAD`, '--', ...c.files], { cwd: root })).stdout.trim();
  if (later) throw new PlanEditError(`a later change touched the same tasks (${later.split('\n')[0]}); undo would lose it`);
  // Each file as it was before the change; a file the change created goes.
  for (const rel of c.files) {
    const before = await exec('git', ['show', `${c.commit}^:${rel}`], { cwd: root, maxBuffer: 20_000_000 }).then((r) => r.stdout, () => undefined);
    if (before === undefined) rmSync(join(root, rel), { force: true });
    else atomicWrite(join(root, rel), before);
  }
  const r = await afterEdit(root, c.files.map((f) => join(root, f)), `Plan: undo ${c.what} (${ownerOf(root)}, in Helix Loop)`);
  append(file, { type: 'undone', id, at: new Date(now).toISOString(), commit: r.commit });
  return { commit: r.commit };
}
