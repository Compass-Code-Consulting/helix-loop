import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { resolveSection, sliceSection, type SpecIndex } from './spec/index.ts';
import { clipNote } from './summary.ts';
import type { CarryReason, Task } from './types.ts';

// Builds one pass's prompt from the template, the task, and only the spec text the task cites
// (L2). That is checked against a byte budget, less a reserve for what a retry must be told; over budget
// is an error, never a silent cut. A retry's notes then get the room that leaves, so a retry never fails it.

// Kept free of the spec in every prompt, for the header that tells a retry its earlier work is in its worktree.
export const RETRY_RESERVE_BYTES = 1024;

export class PromptOverBudget extends Error {
  readonly bytes: number;
  readonly taskId: string;
  constructor(bytes: number, budget: number, taskId: string) {
    super(`prompt for ${taskId} is ${bytes} bytes, over the ${budget}-byte budget less the ${RETRY_RESERVE_BYTES} kept for a retry; the task cites too much spec and should be split`);
    this.bytes = bytes;
    this.taskId = taskId;
  }
}

export interface RenderInput {
  template: string;
  task: Task;
  index: SpecIndex;
  sectionsDir: string;
  retryLog?: string; // tail of the last failed attempt's gate or agent output
  carried?: CarriedWork; // an earlier attempt's work, already in the worktree
  budgetBytes: number;
}

// Work an earlier attempt kept, merged into the pass's worktree before it started (merge.ts, carryInto).
export interface CarriedWork {
  branch: string;
  why: CarryReason;
  conflicts: string[]; // git's account of each conflict it left, one line each
}

export function specExcerpt(task: Task, index: SpecIndex, sectionsDir: string): string {
  const parts: string[] = [];
  const included: { file: string; startLine: number; endLine: number }[] = [];
  const covered = (file: string, line: number) => included.some((r) => r.file === file && line >= r.startLine && line <= r.endLine);
  for (const cite of task.spec) {
    const s = resolveSection(index, cite);
    if (!s || included.some((r) => r.file === s.file && r.startLine <= s.startLine && r.endLine >= s.endLine)) continue;
    included.push(s);
    parts.push(sliceSection(sectionsDir, s));
  }
  // Each requirement's own definition, unless a cited section already holds it.
  for (const id of task.reqs) {
    const r = index.reqs[id];
    if (!r || covered(r.file, r.startLine)) continue;
    included.push(r);
    parts.push(`(${r.section}${r.subsection ? `, ${r.subsection.slice(r.section.length + 1)}` : ''})\n${sliceSection(sectionsDir, r)}`);
  }
  return parts.join('\n\n---\n\n');
}

export function renderPrompt(input: RenderInput): string {
  const { template, task, index, sectionsDir } = input;
  // The glossary without its list of sources: links builders never follow, sent with every prompt.
  const glossary = index.glossary && index.sections[index.glossary] ? sliceSection(sectionsDir, index.sections[index.glossary]!).split(/\n#{2,4} Sources\b/)[0]!.trimEnd() : '';
  const taskYaml = stringify(
    { id: task.id, repo: task.repo, area: task.area, title: task.title, reqs: task.reqs, acceptance: task.acceptance, notes: task.notes },
    { lineWidth: 0 },
  ).trim();
  const spec = specExcerpt(task, index, sectionsDir);
  // Replaced through functions: a replacement string would expand any `$&`, `$'` or `$$` a note or the spec holds.
  const fill = (retry: string) =>
    template
      .replaceAll('{{TASK_ID}}', () => task.id)
      .replaceAll('{{REPO}}', () => task.repo)
      .replaceAll('{{TASK}}', () => taskYaml)
      .replaceAll('{{SPEC}}', () => spec)
      .replaceAll('{{GLOSSARY}}', () => glossary)
      .replaceAll('{{SPEC_VERSION}}', () => index.version)
      .replaceAll('{{RETRY}}', () => retry);
  const base = fill('');
  const bytes = Buffer.byteLength(base);
  if (bytes + RETRY_RESERVE_BYTES > input.budgetBytes) throw new PromptOverBudget(bytes, input.budgetBytes, task.id);
  // What a retry is told, most needed first: that its earlier work is in its worktree (always: the reserve
  // holds it), the conflicts git left there, then the end of the last failed attempt's output, each in the
  // room the ones before it leave.
  let room = input.budgetBytes - bytes;
  let retry = '';
  const add = (text: string) => {
    retry += text;
    room -= Buffer.byteLength(text);
  };
  if (input.carried) {
    add(carriedHeader(input.carried));
    const list = fitLines(input.carried.conflicts.map((c) => `- ${c}`), room - Buffer.byteLength(CONFLICTS));
    if (list) add(CONFLICTS + list);
  }
  if (input.retryLog) {
    const head = input.carried
      ? "\n\nThe end of the last failed attempt's output:\n\n```text\n"
      : '## Your previous attempt failed\n\nThe loop discarded it; you are starting again from `main`. The end of its output:\n\n```text\n';
    const tail = '\n```';
    const note = fitBytes(input.retryLog, room - Buffer.byteLength(head + tail));
    if (note) add(head + note + tail);
  }
  return retry ? fill(retry) : base;
}

// What the next attempt is told about kept work, by why it did not merge, and what to do with it first.
const CARRIED: Record<CarryReason, { said: string; first: string }> = {
  moved: { said: "An earlier attempt's work passed its gate but could not merge, because `main` changed under it.", first: 'check it against the current code' },
  failed: { said: "Your last attempt's work failed the gate; the end of its output is below.", first: 'fix what failed' },
  cut: { said: 'An earlier attempt was stopped before it finished: it ran out of time, hit a session limit or ended with an error.', first: 'finish it' },
  blocked: { said: "An earlier attempt stopped as blocked; the task's notes say how a person answered.", first: 'finish it as the notes now say' },
};

const carriedHeader = (c: CarriedWork) => `## Your earlier work on this task is in your worktree

${CARRIED[c.why].said} The loop has merged that work, kept on branch \`${c.branch}\`, into the current \`main\` in your worktree, uncommitted. Build on it rather than starting over: ${CARRIED[c.why].first}, resolve any conflicts so that both sides' changes survive, make it pass, and commit. If its approach is wrong, discard it (\`git checkout -- . && git clean -fd\`) and start again.`;

const CONFLICTS =
  "\n\nGit left these conflicts. Where both sides changed the same lines, the file holds markers: `<<<<<<< HEAD` opens the current main's side, `|||||||` the common base, `=======` the earlier work, and `>>>>>>>` closes it.\n\n";

// As many of the lines as fit in `room` bytes, ending with a count of any left out.
function fitLines(lines: string[], room: number): string {
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1;
    const tail = rest ? `\n- … and ${rest} more` : '';
    if (Buffer.byteLength([...out, line].join('\n') + tail) > room) {
      if (out.length) out.push(`- … and ${lines.length - i} more`);
      break;
    }
    out.push(line);
  }
  return out.join('\n');
}

// The note cut to at most `room` UTF-8 bytes, keeping its first line and its end (clipNote).
function fitBytes(text: string, room: number): string {
  let limit = Math.min(text.length, room);
  while (limit > 0) {
    const out = clipNote(text, limit);
    if (Buffer.byteLength(out) <= room) return out;
    limit = Math.floor(limit * 0.9);
  }
  return '';
}

export function loadTemplate(promptsDir: string, name: 'build' | 'plan'): string {
  return readFileSync(join(promptsDir, `${name}.md`), 'utf8');
}
