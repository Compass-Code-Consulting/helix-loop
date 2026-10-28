import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, parse, parseDocument, stringify } from 'yaml';
import { atomicWrite } from './store.ts';

// TaskSet revisions. Revision 1 is the TaskSet as first planned; applying Helix Milestones, or importing a new
// TaskSet over one, writes the next. The revision it replaces is kept whole in plan/history/r<N>/ (taskset.yaml,
// milestones.yaml when it had one, tasks/, human/), never edited again: the plan as it was when superseded. The live
// plan keeps changing status as the loop runs. plan/history/index.yaml records each revision.

export interface Revision {
  revision: number;
  date: string; // when it became the current revision
  by: string;
  why: string;
  tasks: number;
  placeholders?: number; // tasks built against a placeholder, and the wiring tasks, it added
  wiring?: number;
  snapshot?: string; // where it is kept once superseded, relative to plan/
}

export const historyDir = (planDir: string) => join(planDir, 'history');
const indexFile = (planDir: string) => join(historyDir(planDir), 'index.yaml');

export function readHistory(planDir: string): Revision[] {
  const f = indexFile(planDir);
  if (!existsSync(f)) return [];
  const raw = parse(readFileSync(f, 'utf8')) as { revisions?: Revision[] } | null;
  return Array.isArray(raw?.revisions) ? raw.revisions : [];
}

export function writeHistory(planDir: string, revisions: Revision[]): void {
  mkdirSync(historyDir(planDir), { recursive: true });
  atomicWrite(indexFile(planDir), `# Each revision of the TaskSet: when it became current, who made it and why. Superseded ones are kept in r<N>/.\n${stringify({ revisions }, { lineWidth: 0 })}`);
}

// Copies revision `n` as it stands into history/r<n>/ and returns the files written, relative to planDir. A
// snapshot is never overwritten: one that exists means the history and the TaskSet's revision disagree.
export function snapshot(planDir: string, n: number, milestonesFile?: string): string[] {
  const dir = join(historyDir(planDir), `r${n}`);
  if (existsSync(dir)) throw new Error(`plan/history/r${n}/ exists already: the TaskSet says revision ${n}, which was superseded before. Set its revision past the last one in plan/history/index.yaml`);
  mkdirSync(dir, { recursive: true });
  const parts = ['taskset.yaml', ...(milestonesFile ? [milestonesFile] : []), 'tasks', 'human'];
  for (const part of parts) if (existsSync(join(planDir, part))) cpSync(join(planDir, part), join(dir, part), { recursive: true });
  return [join('history', `r${n}`)];
}

// A TaskSet document as its planner wrote it (comments, order and quoting kept), with the revision and the milestones
// file it names set: `milestones` right after `revision`, or gone when there are none yet.
export function reviseTaskSetText(text: string, revision: number, milestones?: string): string {
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new Error('taskset.yaml is not a mapping');
  doc.set('revision', revision);
  doc.delete('milestones');
  if (milestones) {
    const items = doc.contents.items;
    const at = items.findIndex((i) => isScalar(i.key) && i.key.value === 'revision');
    const pair = doc.createPair('milestones', milestones);
    items.splice(at + 1, 0, pair as (typeof items)[number]);
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// A Milestones document as the skill wrote it, planned against `revision`.
export function reviseMilestonesText(text: string, revision: number): string {
  const doc = parseDocument(text);
  doc.set('taskset_revision', revision);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
