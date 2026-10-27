import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { outputTail, type FeedKind, type FeedStep } from '../agents/adapter.ts';
import { describeClaude } from '../agents/claude.ts';
import { describeCodex } from '../agents/codex.ts';
import { GATE_FAILED_AT, stepEnd, stepName } from '../gate.ts';
import type { AgentName } from '../types.ts';

// A pass's activity feed for the loop app (spec §5.1): its log, read as it grows, turned into what its builder
// did, in order. Each CLI's own lines are described by its adapter module; the rest of the log is the
// harness's: the prepare step's install and the gate, whose steps are tracked as one item per gate run. A run
// of reads and searches is one item, as is a run of plain output. A log is read from where the last read
// stopped, so a page watching a pass costs a few kilobytes a second, however long the pass.

export type FeedState = 'running' | 'ok' | 'failed';
export interface GateStep {
  step: string;
  state: FeedState;
  ms?: number;
}
export interface FeedItem {
  key: number; // the byte offset of the line it started at: stable while the log grows
  v: number; // bumped on every change, so the page redraws only what changed
  kind: FeedKind | 'look' | 'gate' | 'output';
  text: string;
  detail?: string;
  note?: string;
  state?: FeedState;
  count?: number; // look: the calls merged; output and gate: the lines of output
  steps?: GateStep[]; // gate
  at?: string; // when the reader first saw it: only for what a pass wrote while the app watched; a log read whole has no times
}
export type FeedPhase = 'setup' | 'agent' | 'gate';
export interface Feed {
  items: FeedItem[]; // the last `limit`
  earlier: number; // items before those
  phase: FeedPhase; // as the log shows it: the loop's runs/live.json says it better while it writes one
  done: boolean; // the builder's turn has ended
  summary: { toolCalls: number; commands: number; failed: number; files: number };
  lastMessage?: string;
  size: number;
  updatedAt: string; // the log's last write
}

const KEEP = 2000; // items held per log
const FIRST_READ = 8 * 1024 * 1024; // of a longer log, only its end
const TAIL_LINES = 40;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TOOL_KINDS = new Set<string>(['command', 'edit', 'read', 'search', 'tool', 'report', 'issue', 'plan']);
const DESCRIBE: Record<AgentName, (line: string) => FeedStep[] | undefined> = { claude: describeClaude, codex: describeCodex };

class Reader {
  offset = 0;
  partial = Buffer.alloc(0);
  items: FeedItem[] = [];
  earlier = 0;
  refs = new Map<string, FeedItem>();
  phase: FeedPhase = 'setup';
  done = false;
  summary = { toolCalls: 0, commands: 0, failed: 0, files: 0 };
  files = new Set<string>();
  lastMessage?: string;
  tail: string[] = []; // the open output or gate item's last lines
  mtime = 0;
  stamp?: string; // the time of this read, given to the items it creates
  private shorten: (s: string) => string;
  private describe: (line: string) => FeedStep[] | undefined;

  constructor(agent: AgentName, root: string) {
    this.describe = DESCRIBE[agent];
    // Paths in a builder's worktree read as the repo's own; the control plane's, as its own.
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const worktree = new RegExp(`${esc}/worktrees/[^/]+/[^/]+/`, 'g');
    const plane = new RegExp(`${esc}/`, 'g');
    this.shorten = (s) => s.replace(worktree, '').replace(plane, '');
  }

  feed(buf: Buffer, start: number): void {
    let at = 0;
    const data = this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
    const base = start - this.partial.length;
    for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, at)) {
      this.line(data.subarray(at, nl).toString('utf8'), base + at);
      at = nl + 1;
    }
    this.partial = Buffer.from(data.subarray(at));
  }

  private last = () => this.items.at(-1);
  private bump = (i: FeedItem) => void i.v++;
  private push(item: Omit<FeedItem, 'v'>): FeedItem {
    const i = { ...item, v: 1, ...(this.stamp ? { at: this.stamp } : {}) };
    this.items.push(i);
    if (this.items.length > KEEP) {
      const gone = this.items.splice(0, this.items.length - KEEP);
      this.earlier += gone.length;
      for (const [ref, it] of this.refs) if (gone.includes(it)) this.refs.delete(ref);
    }
    return i;
  }

  private line(raw: string, key: number): void {
    const steps = this.describe(raw);
    if (steps) {
      if (this.phase === 'setup') this.phase = 'agent';
      return void steps.forEach((s) => this.step(s, key));
    }
    const text = (raw.split('\r').at(-1) ?? '').replace(ANSI, '').trimEnd();
    if (!text.trim()) return;
    this.text(text, key);
  }

  // A line of the CLI's own output.
  private step(s: FeedStep, key: number): void {
    const shorten = (x?: string) => (x === undefined ? undefined : this.shorten(x));
    const known = s.ref ? this.refs.get(s.ref) : undefined;
    if (known) {
      const was = known.state;
      if (known.kind === 'look') {
        if (s.state === 'failed') known.state = 'failed';
      } else {
        if (s.kind && s.kind !== known.kind) known.kind = s.kind;
        if (s.text) known.text = shorten(s.text)!;
        if (s.detail) known.detail = shorten(s.detail);
        if (s.state) known.state = s.state;
      }
      if (known.state === 'failed' && was !== 'failed') this.summary.failed++;
      this.addFiles(s.paths);
      return this.bump(known);
    }
    if (!s.kind) return;
    if (TOOL_KINDS.has(s.kind)) this.summary.toolCalls++;
    if (s.kind === 'command') this.summary.commands++;
    if (s.state === 'failed') this.summary.failed++;
    this.addFiles(s.paths);
    if (s.kind === 'message') this.lastMessage = shorten(s.text);
    if (s.kind === 'done') {
      this.done = true;
      this.phase = 'gate';
    }
    this.tail = [];
    // Reads and searches in a row are one item.
    if (s.kind === 'read' || s.kind === 'search') {
      const prev = this.last();
      const line = `${s.kind === 'read' ? 'read' : 'search'} ${shorten(s.text)}`;
      if (prev?.kind === 'look') {
        prev.count = (prev.count ?? 1) + 1;
        prev.detail = `${prev.detail}\n${line}`;
        prev.text = lookText(prev.detail);
        if (s.ref) this.refs.set(s.ref, prev);
        return this.bump(prev);
      }
      const item = this.push({ key, kind: 'look', text: '', detail: line, count: 1 });
      item.text = lookText(line);
      if (s.ref) this.refs.set(s.ref, item);
      return;
    }
    // A plan is shown once, where it last changed.
    if (s.kind === 'plan') {
      const prev = this.items.findLastIndex((i) => i.kind === 'plan');
      if (prev >= 0) this.items.splice(prev, 1);
    }
    const item = this.push({ key, kind: s.kind, text: shorten(s.text) ?? '', detail: shorten(s.detail), note: s.note, state: s.state });
    if (s.ref) this.refs.set(s.ref, item);
  }

  private addFiles(paths?: string[]): void {
    for (const p of paths ?? []) if (p) this.files.add(this.shorten(p));
    this.summary.files = this.files.size;
  }

  // A line of the harness's own: the prepare step and the gate.
  private text(text: string, key: number): void {
    const prev = this.last();
    const gate = prev?.kind === 'gate' ? prev : undefined;
    const step = stepName(text);
    if (step) {
      if (this.phase !== 'setup') this.phase = 'gate';
      if (gate && !gate.steps!.some((x) => x.step === step)) {
        // A runner that reports no step's end runs them one at a time: the one before has ended.
        if (!gate.steps!.some((x) => x.ms !== undefined)) for (const x of gate.steps!) if (x.state === 'running') x.state = 'ok';
        gate.steps!.push({ step, state: 'running' });
        gate.text = gateText(gate.steps!);
        return this.bump(gate);
      }
      this.tail = [];
      const item = this.push({ key, kind: 'gate', text: '', steps: [{ step, state: 'running' }], count: 0, state: 'running' });
      item.text = gateText(item.steps!);
      return;
    }
    const end = stepEnd(text);
    if (end && gate) {
      const s = gate.steps!.find((x) => x.step === end.step);
      if (s) Object.assign(s, { state: end.ok ? 'ok' : 'failed', ms: end.ms });
      gate.text = gateText(gate.steps!);
      return this.bump(gate);
    }
    const failedAt = GATE_FAILED_AT.exec(text)?.[1];
    if (failedAt && gate) {
      const s = gate.steps!.find((x) => x.step === failedAt);
      if (s) s.state = 'failed';
      for (const x of gate.steps!) if (x.state === 'running' && x.ms === undefined) x.state = 'ok';
      gate.state = 'failed';
      gate.text = gateText(gate.steps!);
    }
    // Output: onto the open gate or output item, or a new output item.
    const into = gate ?? (prev?.kind === 'output' ? prev : undefined);
    if (into) {
      this.tail.push(text);
      if (this.tail.length > TAIL_LINES) this.tail.shift();
      into.count = (into.count ?? 0) + 1;
      into.detail = outputTail(this.shorten(this.tail.join('\n')), TAIL_LINES, 6000);
      if (into.kind === 'output') into.text = outputText(this.phase, into.count);
      return this.bump(into);
    }
    this.tail = [text];
    this.push({ key, kind: 'output', text: outputText(this.phase, 1), detail: this.shorten(text), count: 1 });
  }

  // A pass that has ended leaves nothing running.
  settle(): void {
    for (const i of this.items) {
      if (i.state === 'running') i.state = i.kind === 'gate' && i.steps!.some((x) => x.state === 'failed') ? 'failed' : undefined;
      for (const s of i.steps ?? []) if (s.state === 'running') s.state = 'ok';
      if (i.steps) i.text = gateText(i.steps);
    }
  }

  view(limit: number, size: number): Feed {
    return {
      // Copies: the reader keeps changing its own as the log grows.
      items: limit ? this.items.slice(-limit).map((i) => ({ ...i, steps: i.steps?.map((x) => ({ ...x })) })) : [],
      earlier: this.earlier + Math.max(0, this.items.length - limit),
      phase: this.phase,
      done: this.done,
      summary: { ...this.summary },
      lastMessage: this.lastMessage,
      size,
      updatedAt: new Date(this.mtime).toISOString(),
    };
  }
}

function lookText(detail: string): string {
  const lines = detail.split('\n');
  const reads = lines.filter((l) => l.startsWith('read ')).length;
  const searches = lines.length - reads;
  const parts = [reads ? `Read ${reads === 1 ? lines.find((l) => l.startsWith('read '))!.slice(5) : `${reads} files`}` : '', searches ? `searched ${searches === 1 && !reads ? `for ${lines[0]!.slice(7)}` : `${searches} time${searches === 1 ? '' : 's'}`}` : ''].filter(Boolean);
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function gateText(steps: GateStep[]): string {
  const n = (st: FeedState) => steps.filter((x) => x.state === st).length;
  const failed = steps.filter((x) => x.state === 'failed').map((x) => x.step);
  return [`Gate: ${n('ok')} of ${steps.length} step${steps.length === 1 ? '' : 's'} passed`, failed.length ? `${failed.join(', ')} failed` : '', n('running') ? `${n('running')} running` : ''].filter(Boolean).join(' · ');
}

const outputText = (phase: FeedPhase, n: number) => `${phase === 'setup' ? 'Setting up' : phase === 'gate' ? 'Preparing the gate' : 'Output'} · ${n} line${n === 1 ? '' : 's'}`;

// Readers by log, the few most recently read kept.
const readers = new Map<string, Reader>();
const MAX_READERS = 12;

// The feed of the pass log `file` (absolute; a finished pass's is gzipped), its last `limit` items.
export function readFeed(file: string, agent: AgentName, root: string, limit = 400): Feed | undefined {
  if (!existsSync(file)) return undefined;
  const st = statSync(file);
  const id = `${agent}:${file}`;
  let r = readers.get(id);
  if (r && (st.size < r.offset || (file.endsWith('.gz') && st.mtimeMs !== r.mtime))) r = undefined;
  if (!r) {
    r = new Reader(agent, root);
    if (file.endsWith('.gz')) {
      const data = gunzipSync(readFileSync(file));
      r.feed(data, 0);
      r.feed(Buffer.from('\n'), data.length);
      r.settle();
      r.offset = st.size;
    } else if (st.size > FIRST_READ) {
      // Start at a line, not in the middle of one.
      r.offset = st.size - FIRST_READ;
      r.partial = Buffer.alloc(0);
      const skip = readRange(file, r.offset, Math.min(st.size, r.offset + 64 * 1024));
      const nl = skip.indexOf(10);
      r.offset += nl >= 0 ? nl + 1 : 0;
    }
  }
  readers.delete(id);
  readers.set(id, r);
  if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value!);
  if (!file.endsWith('.gz') && st.size > r.offset) {
    // A reader that has read before sees new lines as they come: they get this moment as their time.
    r.stamp = r.mtime ? new Date(st.mtimeMs).toISOString() : undefined;
    r.feed(readRange(file, r.offset, st.size), r.offset);
    r.offset = st.size;
  }
  r.mtime = st.mtimeMs;
  return r.view(limit, st.size);
}

function readRange(file: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(to - from);
  const fd = openSync(file, 'r');
  try {
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}
