import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { setPriority } from 'node:os';
import { createInterface } from 'node:readline';

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  logFile?: string; // stdout and stderr, appended
  onLine?: (line: string) => void; // each stdout line
  signal?: AbortSignal;
  nice?: number; // the command's CPU priority, lowered: everything it starts inherits it
}

// Builders' work (the agent, every command it runs and its browser tests) yields the CPU to the gates, which
// decide what merges. On a busy machine gate tests ran out of time while builders ran their own suites beside
// them, failing passes whose work was sound (2026-10-26).
export const BUILDER_NICE = 10;

// Lowers a process's CPU priority straight after it starts, before it has started anything else.
export function lowerPriority(pid: number | undefined, nice: number): void {
  if (pid === undefined) return;
  try {
    setPriority(pid, nice);
  } catch {
    // already gone
  }
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: string; // both, in the order they arrived, as the log file has them
}

const KEEP = 256 * 1024; // tail of output kept in memory

// Runs a command in its own process group. When it ends (or times out) the whole group is killed,
// so nothing an agent started can outlive its pass (L7): no background check left running.
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (opts.nice) lowerPriority(child.pid, opts.nice);
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    const keep = (buf: string, add: string) => (buf + add).slice(-KEEP);

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      stdout = keep(stdout, line + '\n');
      output = keep(output, line + '\n');
      log?.write(line + '\n');
      opts.onLine?.(line);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = keep(stderr, s);
      output = keep(output, s);
      log?.write(s);
    });

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => killGroup('SIGTERM');
    // A signal aborted before the spawn fires no event: without this, the command would run its whole course.
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      killGroup('SIGKILL'); // stragglers the agent left behind
      const done = () => resolve({ code, signal, timedOut, stdout, stderr, output });
      if (log) log.end(done);
      else done();
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

// Runs a shell command line (for configured gate commands).
export function sh(command: string, opts: RunOptions): Promise<RunResult> {
  return run('/bin/sh', ['-c', command], opts);
}
