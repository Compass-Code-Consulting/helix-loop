import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Clock } from './clock.ts';
import { suspensionWatch } from './clock.ts';
import { addedConflictMarkers, changedFiles, commitsAhead, git, isDirty } from './git.ts';
import { sh } from './proc.ts';
import type { Task } from './types.ts';

// The gate (design doc §4 step 6): the loop's checks on a finished pass, then the repo's own full
// check. Nothing reaches main without passing it.

// `detail` goes to the next attempt's prompt; `failing` names what failed in a few words, for the map.
// `steps` times the prepare step and each step the repo's gate runner announced; `failedStep` names the
// step that failed, or the loop's own check ("harness:…") that refused the pass before the repo's gate ran.
export interface GateStep {
  step: string;
  ms: number;
}
export type GateOutcome =
  | { ok: true; commit: string; gateMs: number; steps: GateStep[] }
  | {
      ok: false;
      outcome: 'no_commit' | 'forbidden_paths' | 'gate_failed' | 'suspended';
      detail: string;
      gateMs: number;
      failing?: string;
      failedStep: string;
      steps: GateStep[];
    };

export interface GateInput {
  worktree: string;
  task: Task;
  agentLabel: string; // "claude (claude-opus-5-5)", for the commit trailer
  summary: string; // the agent's final message; becomes the commit message when the loop commits
  gateCommand: string;
  prepare?: string; // the repo's install step, run on the fresh checkout before gateCommand
  gateTimeoutMs: number;
  forbidden: string[];
  allowed?: string[]; // exceptions to `forbidden`
  restricted: Record<string, string>; // path glob → the area prefix allowed to change it
  agentsMdBudget: number;
  suspensionMs: number;
  clock: Clock;
  logFile: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal; // kills the prepare step and the gate command: the pass was stopped from the loop app
}

// Finishes a dirty tree by committing it, with the agent's final message as the message (L7).
export async function commitLeftovers(worktree: string, task: Task, summary: string, agentLabel: string): Promise<boolean> {
  if (!(await isDirty(worktree))) return false;
  await git(worktree, 'add', '-A');
  const first = summary.split('\n')[0]?.trim() ?? '';
  const subject = first.startsWith(`${task.id}:`) ? first.slice(0, 100) : `${task.id}: ${task.title}`.slice(0, 100);
  const body = summary.split('\n').slice(first.startsWith(`${task.id}:`) ? 1 : 0).join('\n').trim();
  const message = `${subject}\n\n${body}\n\nTask: ${task.id} [${task.reqs.join(', ')}]\nAgent: ${agentLabel}`.replace(/\n{3,}/g, '\n\n');
  await git(worktree, '-c', 'user.name=Mushy Loop', '-c', 'user.email=loop@mushymarketing.com', 'commit', '-q', '--no-verify', '-m', message);
  return true;
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// The changed paths no task may touch: those a forbidden pattern matches, minus the allowed exceptions.
export function forbiddenPaths(changed: string[], forbidden: string[], allowed: string[]): string[] {
  const no = forbidden.map(globToRegExp);
  const yes = allowed.map(globToRegExp);
  return changed.filter((f) => no.some((p) => p.test(f)) && !yes.some((p) => p.test(f)));
}

// The changed paths a task in `area` may not touch: a restricted path belongs to its area and the areas below it.
export function offAreaPaths(changed: string[], restricted: Record<string, string>, area: string): string[] {
  return changed.filter((f) => Object.entries(restricted).some(([glob, owner]) => globToRegExp(glob).test(f) && area !== owner && !area.startsWith(`${owner}/`)));
}

// What a failed gate run names first, for the map and the head of the attempt's note: a failing test,
// then a type error, then a lint error, then an uncaught exception, then any error line, else the last
// line printed. Each kind is looked for in turn, earliest first, and a package manager's "Command failed"
// line or a command it echoes never counts. A gate runner stops at the step that fails, so that step's
// output is searched first: earlier steps' output (an "Error code check passed" line) can't be blamed.
const FAILURES: RegExp[] = [
  /^\s*FAIL\s+(\S.*)$/, // vitest and jest: "FAIL  src/a.test.ts > adds"
  /^\s*\d+\)\s+(\[[^\]]+\]\s+›\s+.+)$/, // Playwright: "1) [chromium] › e2e/home.spec.ts:3:1 › title"
  /^\s*(?:[×✗✖✘]|not ok \d+(?: -)?)\s+(?!\d+ problems?\b)(.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?$/, // ×, ✗, ✖, ✘ and TAP, without the timing (not eslint's "✖ 2 problems")
  /^\s*(\S.*\berror\s+TS\d+:.*)$/i, // tsc and astro check
];
const LINT = /^\s*(\d+:\d+\s+error\s+.+)$/; // eslint, under its file's line
const UNCAUGHT = /^\s*((?:[A-Z]\w*)?Error(?: \[[A-Z_]+\])?: \S.*)$/; // a script's uncaught exception: "Error: …", "TypeError: …"
const ANY_ERROR = /\b(?:error|failed|failure)\b|ERR!|ERR_PNPM_/i;
const WRAPPER = /ELIFECYCLE|Command failed with exit code|^\s*[>$] /; // a package manager saying a script failed, or echoing one it runs
// A gate runner starting a step: mushy-social-media's "> gate 70-unit: …", mushy-website's "Checking 40-unit.ts",
// mushy-docs' "Checking: scripts/checks/40-unit.ts". stepName gives the step's name.
const STEP = /^\s*(?:> gate (\S+):|Checking:? (\S+)\.[cm]?[jt]s$)/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // terminal colours

// A gate runner that runs steps at the same time reports each one when it ends, with its own time:
// "< gate 15-lint: passed in 31.2s", "< gate 70-unit: failed in 12s (exit 1)"; and the first failed one last:
// "Gate failed at 70-unit (exit 1)".
const STEP_END = /^\s*<\s+gate\s+(\S+):\s+(passed|failed)\s+in\s+(\d+(?:\.\d+)?)s\b/;
export const GATE_FAILED_AT = /^\s*Gate failed at (\S+?)(?: \(|$)/;
export function stepEnd(line: string): { step: string; ok: boolean; ms: number } | undefined {
  const m = STEP_END.exec(line.replace(ANSI, ''));
  return m ? { step: m[1]!, ok: m[2] === 'passed', ms: Math.round(Number(m[3]) * 1000) } : undefined;
}

export function stepName(line: string): string | undefined {
  const m = STEP.exec(line.replace(ANSI, ''));
  return m ? (m[1] ?? basename(m[2]!)) : undefined;
}

export function firstFailure(output: string): string | undefined {
  const lines = output.replace(ANSI, '').split('\n').map((l) => l.trimEnd());
  const last = lines.reduce((at, l, i) => (STEP.test(l) ? i : at), -1);
  return (last >= 0 ? failureIn(lines.slice(last + 1)) : undefined) ?? failureIn(lines);
}

function failureIn(lines: string[]): string | undefined {
  for (const re of FAILURES) {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m[1]!.replace(/[\s─━]+$/, '').trim(); // Playwright underlines its headings
    }
  }
  let file = '';
  for (const l of lines) {
    if (/^\S.*\.[a-z]+$/i.test(l)) file = l.trim();
    const m = LINT.exec(l);
    if (m) return `${file ? `${file} ` : ''}${m[1]!.replace(/\s+/g, ' ')}`;
  }
  // An uncaught exception is printed last, after any errors a passing step logged on purpose.
  const uncaught = [...lines].reverse().map((l) => UNCAUGHT.exec(l)).find(Boolean);
  if (uncaught) return uncaught[1]!.trim();
  const said = lines.filter((l) => l.trim() && !WRAPPER.test(l));
  return said.find((l) => ANY_ERROR.test(l))?.trim() || said.pop()?.trim();
}

// Every acceptance line must exist, word for word, as a test title somewhere in the repo's tests. A long
// title may be split the ways a line-length rule forces: string literals joined with +, or a backslash
// line continuation.
const joinedStrings = (source: string) => source.replace(/\\\r?\n/g, '').replace(/(["'`])\s*\+\s*\1/g, '');

export function missingAcceptanceTests(worktree: string, task: Task): string[] {
  const titles = task.acceptance.map((a) => a.replace(/^(e2e|unit|integration):\s*/, ''));
  const remaining = new Set(titles);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (remaining.size === 0) return;
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) && st.size < 2_000_000) {
        const text = joinedStrings(readFileSync(p, 'utf8'));
        for (const t of [...remaining]) if (text.includes(t)) remaining.delete(t);
      }
    }
  };
  walk(worktree);
  return [...remaining];
}

// What the page showed when the first browser test failed: Playwright's error-context.md, an outline of the
// page at that moment, so the next attempt sees what was there instead of only what was missing. The gate
// cleans the worktree before it runs, so every file under test-results/ is this run's.
const PAGE_LIMIT = 1500;
export function pageAtFailure(worktree: string): string | undefined {
  const found: { file: string; at: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      if (name === 'error-context.md') found.push({ file: p, at: statSync(p).mtimeMs });
      else if (depth < 4 && name !== 'node_modules' && statSync(p).isDirectory()) walk(p, depth + 1);
    }
  };
  for (const root of ['test-results', 'tests/test-results']) walk(join(worktree, root), 0);
  const first = found.sort((a, b) => a.at - b.at)[0];
  if (!first) return undefined;
  const text = readFileSync(first.file, 'utf8').trim();
  return `${relative(worktree, first.file)}:\n${text.length > PAGE_LIMIT ? `${text.slice(0, PAGE_LIMIT)}\n[…]` : text}`;
}

export async function runGate(input: GateInput): Promise<GateOutcome> {
  const { worktree, task, clock } = input;
  const started = clock.monotonic();
  const elapsed = () => Math.round(clock.monotonic() - started);
  const steps: GateStep[] = [];
  await commitLeftovers(worktree, task, input.summary, input.agentLabel);

  if ((await commitsAhead(worktree, 'main')) === 0) {
    return { ok: false, outcome: 'no_commit', detail: 'the pass changed nothing', gateMs: elapsed(), failedStep: 'harness:no-commit', steps };
  }

  const changed = await changedFiles(worktree, 'main');
  const bad = forbiddenPaths(changed, input.forbidden, input.allowed ?? []);
  if (bad.length) {
    return { ok: false, outcome: 'forbidden_paths', detail: `changed forbidden paths: ${bad.join(', ')}`, gateMs: elapsed(), failedStep: 'harness:forbidden-paths', steps };
  }
  const offArea = offAreaPaths(changed, input.restricted, task.area);
  if (offArea.length) {
    return {
      ok: false,
      outcome: 'forbidden_paths',
      detail: `only tasks in their own area may change: ${offArea.join(', ')}`,
      gateMs: elapsed(),
      failedStep: 'harness:off-area',
      steps,
    };
  }

  const markers = await addedConflictMarkers(worktree, 'main');
  if (markers.length) {
    const lines = new Map<string, string[]>();
    for (const m of markers) {
      const at = m.lastIndexOf(':');
      lines.set(m.slice(0, at), [...(lines.get(m.slice(0, at)) ?? []), m.slice(at + 1)]);
    }
    const where = [...lines].map(([file, at]) => `${file} (line${at.length > 1 ? 's' : ''} ${at.join(', ')})`);
    return {
      ok: false,
      outcome: 'gate_failed',
      detail: `conflict markers are left in ${where.join(', ')}. Resolve each conflict, keeping what both sides meant, and remove its markers.`,
      gateMs: elapsed(),
      failing: `conflict markers are left in ${[...lines.keys()][0]}${lines.size > 1 ? `, and ${lines.size - 1} more` : ''}`,
      failedStep: 'harness:conflict-markers',
      steps,
    };
  }

  const agentsMd = join(worktree, 'AGENTS.md');
  if (existsSync(agentsMd) && statSync(agentsMd).size > input.agentsMdBudget) {
    return {
      ok: false,
      outcome: 'gate_failed',
      detail: `AGENTS.md is ${statSync(agentsMd).size} bytes, over its ${input.agentsMdBudget}-byte budget (L2). Move detail into docs/ and keep AGENTS.md to commands and guardrails.`,
      gateMs: elapsed(),
      failing: `AGENTS.md is over its ${input.agentsMdBudget}-byte budget`,
      failedStep: 'harness:agents-md',
      steps,
    };
  }

  const missing = missingAcceptanceTests(worktree, task);
  if (missing.length) {
    return {
      ok: false,
      outcome: 'gate_failed',
      detail: `no test is titled with these acceptance lines (they must appear word for word; a long title may be split into strings joined with +):\n${missing.map((m) => `- ${m}`).join('\n')}`,
      gateMs: elapsed(),
      failing: `no test is titled "${missing[0]}"${missing.length > 1 ? `, and ${missing.length - 1} more` : ''}`,
      failedStep: 'harness:acceptance',
      steps,
    };
  }

  // The repo's full check, on what a fresh checkout of the commit holds, as in CI: everything git doesn't
  // track goes (build outputs, caches, installs, whatever the pass left), then the prepare step installs
  // from the lockfile. A host suspension during it says nothing about the code: run it again.
  // Each step is timed by the runner's own report when it gives one ("< gate 15-lint: passed in 31.2s"), and
  // otherwise from its announcement to the next one's.
  interface Seen {
    marks: { step: string; at: number }[];
    ends: { step: string; ok: boolean; ms: number }[];
    failedAt?: string;
  }
  const run = (command: string, seen?: Seen) =>
    sh(command, {
      cwd: worktree,
      timeoutMs: input.gateTimeoutMs,
      logFile: input.logFile,
      signal: input.signal,
      env: { ...process.env, ...input.env, CI: '1', MUSHY_GATE_ID: `${task.id}-${relative(join(worktree, '..'), worktree)}` },
      onLine: seen && ((line) => {
        const end = stepEnd(line);
        if (end) return void seen.ends.push(end);
        const step = stepName(line);
        if (step) seen.marks.push({ step, at: clock.monotonic() });
        seen.failedAt ??= GATE_FAILED_AT.exec(line.replace(ANSI, ''))?.[1];
      }),
    });
  for (let tries = 0; tries < 2; tries++) {
    steps.length = 0;
    const slept = suspensionWatch(clock, input.suspensionMs);
    await git(worktree, 'clean', '-ffdxq');
    const prepStarted = clock.monotonic();
    const prep = input.prepare ? await run(input.prepare) : undefined;
    if (prep) steps.push({ step: 'prepare', ms: Math.round(clock.monotonic() - prepStarted) });
    const unprepared = prep !== undefined && (prep.code !== 0 || prep.timedOut);
    const seen: Seen = { marks: [], ends: [] };
    const res = unprepared ? prep : await run(input.gateCommand, seen);
    const ended = clock.monotonic();
    const marks = seen.marks;
    if (seen.ends.length) seen.ends.forEach((e) => steps.push({ step: e.step, ms: e.ms }));
    else marks.forEach((m, i) => steps.push({ step: m.step, ms: Math.round((marks[i + 1]?.at ?? ended) - m.at) }));
    if (slept()) {
      if (tries === 0) continue;
      return { ok: false, outcome: 'suspended', detail: 'the host was suspended during the gate, twice', gateMs: elapsed(), failedStep: 'suspended', steps };
    }
    if (res.code === 0 && !res.timedOut) return { ok: true, commit: await git(worktree, 'rev-parse', 'HEAD'), gateMs: elapsed(), steps };
    // The next attempt reads this: what failed first, then the end of the output, without terminal colours.
    const command = unprepared ? input.prepare! : input.gateCommand;
    const output = res.output.replace(ANSI, '');
    const tail = output.trim().split('\n').slice(-80).join('\n');
    const failed = res.timedOut
      ? `it timed out after ${Math.round(input.gateTimeoutMs / 60_000)} minutes`
      : (firstFailure(output) ?? `${command} exited with code ${res.code}`);
    const failing = unprepared ? `its prepare step, ${failed}` : failed;
    const failedStep = unprepared ? 'prepare' : (seen.failedAt ?? seen.ends.find((e) => !e.ok)?.step ?? marks.at(-1)?.step ?? 'gate');
    const page = unprepared ? undefined : pageAtFailure(worktree);
    const detail = `the gate failed: ${failing}\n\n${tail}${page ? `\n\nThe page when the first browser test failed (${page})` : ''}`;
    return { ok: false, outcome: 'gate_failed', detail, gateMs: elapsed(), failing, failedStep, steps };
  }
  return { ok: false, outcome: 'gate_failed', detail: 'unreachable', gateMs: elapsed(), failedStep: 'gate', steps };
}
