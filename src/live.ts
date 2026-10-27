import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Clock } from './clock.ts';
import { atomicWrite } from './plan/store.ts';
import type { AgentName } from './types.ts';

// runs/live.json: the passes in flight, for the loop app. The loop rewrites it when a pass starts, changes
// phase or ends, and at most every two seconds while its agent works. The ledger stays the record; this file
// only says what is happening now, and holds each pass's MCP token as a hash, never the token itself.

export type LivePhase = 'setup' | 'agent' | 'gate' | 'merge';

export interface LivePass {
  id: string; // `${task}:${agent}:${attempt}`, the key builder reports are filed under
  task: string;
  repo: string;
  agent: AgentName;
  attempt: number;
  startedAt: string;
  phase: LivePhase;
  phaseAt: string;
  toolCalls: number;
  lastCommand?: string;
  tokenHash?: string; // sha256 of the pass's MCP token
  stopping?: boolean; // the loop app asked for it to stop (runs/stop-pass/), and the loop is ending it
}

export interface LiveFile {
  updatedAt: string;
  pid: number;
  paused?: boolean; // runs/PAUSE exists: the passes in flight run to their end, and no new one starts
  passes: LivePass[];
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(24).toString('base64url');

export function readLive(file: string): LiveFile | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LiveFile;
  } catch {
    return undefined; // mid-rename on a filesystem without atomic rename: the next read gets it
  }
}

const THROTTLE_MS = 2000;

export class LiveBoard {
  private passes = new Map<string, LivePass>();
  private isPaused = false;
  private timer: NodeJS.Timeout | undefined;
  private file: string;
  private clock: Clock;

  constructor(file: string, clock: Clock) {
    this.file = file;
    this.clock = clock;
    this.write();
  }

  start(p: Omit<LivePass, 'phase' | 'phaseAt' | 'toolCalls'>): void {
    this.passes.set(p.task, { ...p, phase: 'setup', phaseAt: p.startedAt, toolCalls: 0 });
    this.write();
  }

  phase(task: string, phase: LivePhase): void {
    const p = this.passes.get(task);
    if (!p || p.phase === phase) return;
    p.phase = phase;
    p.phaseAt = new Date(this.clock.now()).toISOString();
    this.write();
  }

  // What the agent did since the last write, coalesced: one write at most every two seconds.
  activity(task: string, toolCalls: number, lastCommand?: string): void {
    const p = this.passes.get(task);
    if (!p) return;
    p.toolCalls += toolCalls;
    if (lastCommand) p.lastCommand = lastCommand.length > 200 ? `${lastCommand.slice(0, 200)}…` : lastCommand;
    this.timer ??= setTimeout(() => this.write(), THROTTLE_MS).unref();
  }

  stopping(task: string): void {
    const p = this.passes.get(task);
    if (!p || p.stopping) return;
    p.stopping = true;
    this.write();
  }

  paused(paused: boolean): void {
    if (this.isPaused === paused) return;
    this.isPaused = paused;
    this.write();
  }

  end(task: string): void {
    if (this.passes.delete(task)) this.write();
  }

  close(): void {
    this.passes.clear();
    this.isPaused = false; // a loop that has exited holds nothing paused; the next start reads runs/PAUSE again
    this.write();
  }

  private write(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const live: LiveFile = {
      updatedAt: new Date(this.clock.now()).toISOString(),
      pid: process.pid,
      ...(this.isPaused ? { paused: true } : {}),
      passes: [...this.passes.values()],
    };
    try {
      atomicWrite(this.file, `${JSON.stringify(live, null, 2)}\n`);
    } catch {
      // The app reads this file; the loop never stops for it.
    }
  }
}
