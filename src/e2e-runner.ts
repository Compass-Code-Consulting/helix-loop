import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BUILDER_NICE, lowerPriority } from './proc.ts';
import { Semaphore } from './semaphore.ts';

// Browser tests for sandboxed agents. Both agents' sandboxes stop Chromium from starting (macOS
// denies its Mach port registration), so a repo's `pnpm e2e` asks this runner, outside the
// sandbox, to run the worktree's own `e2e:direct` script. The gate already runs agent-written
// tests outside the sandbox; this lets the agent run them before the gate does.
//
// Protocol: POST /run with header `x-helix-pass: <pass id>` and body {"args": [...]}. The pass ID
// names one worktree, registered by the loop for the pass and dropped when it ends. The response
// streams the output and ends with a line `__HELIX_E2E_EXIT__=<code>`. A run never outlives its pass
// or the loop: ending either stops it, so no browser test keeps the loop's process alive.

export const EXIT_MARKER = '__HELIX_E2E_EXIT__=';

// A builder runs the browser tests its change touched; the whole suite is the gate's (and, with scoped gates,
// main's whole-suite runs'). A run counts as narrowed when it names test files or a filter on their paths, a
// title filter (-g), or Playwright's --only-changed, --last-failed or --list. Only a fix-first pass, which may need
// to repeat a suite to show a flaky test fixed, may run the whole suite.
const VALUE_OPTIONS = new Set(['--project', '-c', '--config', '-j', '--workers', '--reporter', '--timeout', '--retries', '--repeat-each', '--max-failures', '--output', '--shard', '--trace', '--global-timeout', '--tsconfig', '--grep-invert', '--browser']);
const NARROWING_OPTIONS = new Set(['-g', '--grep', '--only-changed', '--last-failed', '--list']);
export function narrowsRun(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.split('=')[0]!;
    if (NARROWING_OPTIONS.has(name)) return true;
    if (!a.startsWith('-')) return true; // a test file, or a filter on test files' paths
    if (VALUE_OPTIONS.has(name) && !a.includes('=')) i++;
  }
  return false;
}
export const WHOLE_SUITE_REFUSED =
  "a pass runs the browser tests its change touched, not the whole suite (the loop runs that): name the test files you changed or your acceptance tests' file, such as `pnpm e2e e2e/x.e2e.test.ts`, or filter by title with -g '[ID]'\n";

// What a pass asked of the runner, for its metrics: runs, the time they took, and how many failed.
export interface E2EUse {
  runs: number;
  ms: number;
  failed: number;
}

interface PassEntry {
  worktree: string;
  wholeSuite: boolean; // may run every browser test at once (narrowsRun)
  busy: boolean;
  stop?: (why: string) => void; // ends the run in progress
  use: E2EUse;
}

export class E2ERunner {
  private readonly passes = new Map<string, PassEntry>();
  private server: Server | undefined;
  private readonly script: string;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly slots: Semaphore; // runs at once across passes; the rest wait their turn
  url = '';

  constructor(script: string, timeoutMs: number, log: (line: string) => void, concurrency = 2) {
    this.script = script;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.slots = new Semaphore(concurrency);
  }

  async start(port: number): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    this.server.unref(); // never what keeps the loop's process alive
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  register(worktree: string, opts: { wholeSuite?: boolean } = {}): string {
    const id = randomBytes(24).toString('hex');
    this.passes.set(id, { worktree, wholeSuite: opts.wholeSuite ?? false, busy: false, use: { runs: 0, ms: 0, failed: 0 } });
    return id;
  }

  unregister(id: string): E2EUse | undefined {
    const entry = this.passes.get(id);
    entry?.stop?.('the pass ended');
    this.passes.delete(id);
    return entry?.use;
  }

  async stop(): Promise<void> {
    for (const entry of this.passes.values()) entry.stop?.('the loop stopped');
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/run') return void res.writeHead(404).end();
    const id = req.headers['x-helix-pass'];
    const entry = typeof id === 'string' ? this.passes.get(id) : undefined;
    if (!entry) return void res.writeHead(401).end('unknown or expired pass\n');
    if (entry.busy) return void res.writeHead(409).end('a browser test run is already in progress for this pass\n');

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) return void res.writeHead(413).end();
    }
    let args: string[];
    try {
      const parsed = JSON.parse(body || '{}') as { args?: unknown };
      args = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
    } catch {
      return void res.writeHead(400).end('body must be JSON: {"args": [...]}\n');
    }
    if (args.some((a) => a.length > 500 || a.includes('\0'))) return void res.writeHead(400).end('bad argument\n');
    if (!entry.wholeSuite && !narrowsRun(args)) {
      this.log(`e2e runner: refused a whole-suite run in ${entry.worktree}`);
      return void res.writeHead(422).end(WHOLE_SUITE_REFUSED);
    }

    entry.busy = true;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    // Past the limit, the run waits for a slot; the pass ending or the client leaving meanwhile cancels it.
    let cancelled: string | undefined;
    entry.stop = (why) => {
      cancelled = why;
    };
    const gone = () => {
      cancelled ??= 'the client went away';
    };
    res.once('close', gone);
    if (this.slots.busy >= this.slots.limit) res.write(`helix e2e runner: waiting for a free slot (${this.slots.busy} runs in progress, ${this.slots.queued} waiting)\n`);
    await this.slots.run(() => new Promise<void>((released) => {
      res.off('close', gone);
      if (cancelled || res.destroyed) {
        entry.busy = false;
        entry.stop = undefined;
        if (!res.writableEnded && !res.destroyed) res.end(`\nhelix e2e runner: ${cancelled ?? 'the client went away'}\n${EXIT_MARKER}1\n`);
        return released();
      }
      this.launch(entry, args, res, released);
    }));
  }

  // Runs the worktree's browser tests for one request, streaming the output; `released` frees the slot.
  private launch(entry: PassEntry, args: string[], res: ServerResponse, released: () => void): void {
    this.log(`e2e runner: ${entry.worktree} ${args.join(' ')}`);
    const child = spawn('pnpm', ['run', '--silent', this.script, ...(args.length ? ['--', ...args] : [])], {
      cwd: entry.worktree,
      env: { ...process.env, CI: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lowerPriority(child.pid, BUILDER_NICE); // a builder's run, so it yields to the gates
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    // Every way a run ends comes here once: it finishes, times out, its client goes away, or its pass or
    // the loop ends. The pipes are closed too, so a process that left the group can't hold the loop open.
    let ended = false;
    const started = Date.now();
    const finish = (code: number, why?: string) => {
      if (ended) return;
      ended = true;
      entry.use.runs++;
      entry.use.ms += Date.now() - started;
      if (code !== 0) entry.use.failed++;
      clearTimeout(timer);
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      entry.busy = false;
      entry.stop = undefined;
      if (!res.writableEnded && !res.destroyed) res.end(`\n${why ? `helix e2e runner: ${why}\n` : ''}${EXIT_MARKER}${code}\n`);
      released();
    };
    entry.stop = (why) => finish(1, why);
    const timer = setTimeout(() => finish(1, `stopped after ${Math.round(this.timeoutMs / 60_000)} minutes`), this.timeoutMs);
    timer.unref();
    res.on('close', () => {
      if (child.exitCode === null) finish(1);
    });
    child.stdout.on('data', (d: Buffer) => res.write(d));
    child.stderr.on('data', (d: Buffer) => res.write(d));
    child.on('error', (e) => res.write(`\nhelix e2e runner: ${e.message}\n`));
    child.on('close', (code) => finish(code ?? 1));
  }
}
