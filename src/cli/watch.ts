import { readFeed, type Feed, type FeedItem } from '../app/feed.ts';
import { loopStatus, passesNow, type PassNow } from '../app/state.ts';
import { paths } from '../config.ts';
import { readLedger, type LedgerEvent } from '../ledger.ts';
import { logOnDisk } from '../ops/plan.ts';
import { loadPlan } from '../plan/store.ts';
import type { AgentName } from '../types.ts';
import { fit, WIDTH } from './output.ts';

// A pass's activity in the terminal, as Live shows it in the app: the builder's words, its commands and their
// results, its edits and reads, and the gate's steps. Logs are read as the app reads them (app/feed.ts), from
// where the last read stopped; an item prints once it has settled, so a command prints with its result.

const LABEL: Partial<Record<FeedItem['kind'], string>> = {
  message: 'says', command: 'run', edit: 'edit', look: 'read', plan: 'plan', report: 'report', issue: 'issue', tool: 'tool', error: 'error', output: 'output', done: 'done',
};

export class FeedPrinter {
  private printed = new Set<number>();
  private steps = new Set<string>();
  private earlier = false;
  private out: (line: string) => void;
  private prefix: string;
  private timeZone?: string;
  private times: boolean;
  // times: each line starts with when it was seen, for a pass followed as it runs; what was written before the
  // first read has no time, and gets the column blank so the rest still line up.
  constructor(out: (line: string) => void, prefix = '', timeZone?: string, times = false) {
    this.out = out;
    this.prefix = prefix;
    this.timeZone = timeZone;
    this.times = times;
  }

  // Prints what settled since the last call. `finished`: the pass has ended, so nothing is still changing.
  show(feed: Feed, finished: boolean): void {
    if (feed.earlier && !this.earlier && !this.printed.size) {
      this.earlier = true;
      this.line(`… ${feed.earlier} earlier items left out`);
    }
    feed.items.forEach((it, i) => {
      const last = i === feed.items.length - 1 && !finished;
      if (it.kind === 'gate') return this.gate(it, finished);
      if (this.printed.has(it.key) || it.kind === 'thinking') return;
      const growing = it.kind === 'look' || it.kind === 'output';
      if (it.state === 'running' && !finished) return;
      if (growing && last) return;
      this.printed.add(it.key);
      this.item(it);
    });
  }

  private line(text: string, at?: string): void {
    const time = !this.times ? '' : at ? `${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.timeZone })} ` : ' '.repeat(9);
    this.out(`${this.prefix}${time}${text}`);
  }

  private item(it: FeedItem): void {
    const mark = it.state === 'failed' ? '✗ ' : it.kind === 'command' && it.state === 'ok' ? '✓ ' : '';
    const label = (LABEL[it.kind] ?? it.kind).padEnd(7);
    const room = WIDTH - this.prefix.length - (this.times ? 27 : 18);
    if (it.kind === 'message') {
      const lines = it.text.split('\n').filter((l) => l.trim());
      this.line(`${label}${fit(lines[0] ?? '', room)}`, it.at);
      for (const l of lines.slice(1, 6)) this.line(`${' '.repeat(7)}${fit(l, room)}`);
      if (lines.length > 6) this.line(`${' '.repeat(7)}… ${lines.length - 6} more lines`);
      return;
    }
    this.line(`${label}${mark}${fit(it.text, room)}`, it.at);
    // A failed command shows the end of what it printed.
    if (it.state === 'failed' && it.detail) for (const l of it.detail.split('\n').filter((x) => x.trim()).slice(-5)) this.line(`${' '.repeat(9)}${fit(l, room)}`);
  }

  // The gate prints each step as it ends, then, if it failed, the end of its output.
  private gate(it: FeedItem, finished: boolean): void {
    for (const s of it.steps ?? []) {
      const done = s.state !== 'running' || finished;
      const id = `${it.key}:${s.step}`;
      if (!done || this.steps.has(id)) continue;
      this.steps.add(id);
      this.line(`${'gate'.padEnd(7)}${s.state === 'failed' ? '✗' : '✓'} ${s.step}${s.ms !== undefined ? ` (${Math.round(s.ms / 1000)} s)` : ''}`, it.at);
    }
    if (it.state === 'failed' && !this.printed.has(it.key)) {
      this.printed.add(it.key);
      for (const l of (it.detail ?? '').split('\n').filter((x) => x.trim()).slice(-8)) this.line(`${' '.repeat(9)}${fit(l, WIDTH - this.prefix.length - 18)}`);
    }
  }
}

export const agentOfLog = (rel: string) => /-(claude|codex)-\d+\.log(\.gz)?$/.exec(rel)?.[1] as AgentName | undefined;

// Prints a whole log's activity: a pass that has ended, or one in flight as far as it has got.
export function printLog(root: string, rel: string, out: (line: string) => void, timeZone?: string): boolean {
  const file = logOnDisk(root, rel);
  const agent = agentOfLog(rel);
  if (!file || !agent) return false;
  const feed = readFeed(file, agent, root, 2000);
  if (!feed) return false;
  new FeedPrinter(out, '', timeZone).show(feed, file.endsWith('.gz'));
  return true;
}

const lastPass = (events: LedgerEvent[], task: string, attempt: number) => events.findLast((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.task === task && e.attempt === attempt);

// How a pass ended, from the ledger: "merged", "gate failed at 30-e2e".
export function outcomeOf(root: string, task: string, attempt: number): string | undefined {
  const e = lastPass(readLedger(paths(root).ledger), task, attempt);
  return e && `${e.outcome.replace(/_/g, ' ')}${e.failedStep ? ` at ${e.failedStep}` : ''}${e.failing ? `: ${e.failing}` : ''}`;
}

interface Followed {
  pass: PassNow;
  printer: FeedPrinter;
  goneAt?: number; // when the loop stopped listing it, for a log that is never compressed
}

// Follows passes as their builders write them, every `intervalMs`: one task's pass until it ends, or every pass
// as they start and end until stopped.
export async function follow(root: string, o: { task?: string; out: (line: string) => void; signal: AbortSignal; intervalMs?: number; timeZone?: string }): Promise<void> {
  const followed = new Map<string, Followed>();
  const p = paths(root);
  let waitingSaid = false;
  for (;;) {
    const plan = loadPlan(p.tasks, p.human);
    const events = readLedger(p.ledger);
    const status = loopStatus(root, events);
    const now = passesNow(root, plan, status).filter((x) => !o.task || x.task === o.task);
    for (const pass of now) {
      if (followed.has(pass.id)) continue;
      followed.set(pass.id, { pass, printer: new FeedPrinter(o.out, o.task ? '' : `${pass.task} `, o.timeZone, true) });
      o.out(`▶ ${pass.task} on ${pass.agent}, attempt ${pass.attempt}${pass.title ? `: ${fit(pass.title, 60)}` : ''}`);
    }
    for (const [id, f] of followed) {
      const rel = f.pass.log;
      const file = rel ? logOnDisk(root, rel) : undefined;
      if (file && rel) {
        const feed = readFeed(file, f.pass.agent, root, 2000);
        if (feed) f.printer.show(feed, file.endsWith('.gz'));
      } else if (!rel) {
        // A pass still setting up has no log yet: look for it again.
        f.pass = now.find((x) => x.id === id) ?? f.pass;
      }
      const ended = !!file?.endsWith('.gz');
      const listed = now.some((x) => x.id === id);
      if (!listed) f.goneAt ??= Date.now();
      if (ended || (f.goneAt && Date.now() - f.goneAt > 10_000)) {
        o.out(`■ ${f.pass.task} attempt ${f.pass.attempt} ended${(() => {
          const how = outcomeOf(root, f.pass.task, f.pass.attempt);
          return how ? `: ${how}` : '';
        })()}`);
        followed.delete(id);
        if (o.task) return;
      }
    }
    if (o.task && !followed.size) return;
    if (!status.running && !followed.size && !waitingSaid) {
      o.out('The loop is not running; waiting for it to start (Ctrl-C to stop).');
      waitingSaid = true;
    }
    if (status.running) waitingSaid = false;
    const stop = await new Promise<boolean>((resolve) => {
      if (o.signal.aborted) return resolve(true);
      const t = setTimeout(() => resolve(false), o.intervalMs ?? 2000);
      o.signal.addEventListener('abort', () => (clearTimeout(t), resolve(true)), { once: true });
    });
    if (stop) return;
  }
}
