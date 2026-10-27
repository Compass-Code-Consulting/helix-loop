import type { LedgerEvent } from './ledger.ts';

// How the build has used its two agents, from the ledger alone, since the loop first started.
// While the loop runs, each of an agent's slots (the passes it may run at once) is working (its agent is
// running a pass), gating (the gate is checking that pass), limited (waiting out a usage limit, or held back
// by the agent's weekly pace) or idle (no task it can take). Times are slot-time: two slots for an hour are
// two hours.

export interface AgentUsage {
  agent: string;
  passes: number;
  merged: number;
  workingMs: number;
  gatingMs: number;
  limitedMs: number;
  idleMs: number;
  slotMs: number; // the slot-time the loop ran for: working, gating, limited and idle add up to it
  costUsd: number;
  tokens: { input: number; cachedInput: number; output: number };
}

export interface BuildStats {
  startedAt?: string; // the first loop start
  elapsedMs: number; // first start to now, or to the last exit when the loop has stopped
  upMs: number; // time the loop was running
  merges: number;
  agents: AgentUsage[];
}

type Interval = [number, number];

const overlap = (a: Interval, b: Interval) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

// `running` names the agent of each pass in progress: a pass is logged only when it ends, so each one in
// progress counts as working from that agent's last logged pass, or the loop's last start, whichever is later.
export function buildStats(events: LedgerEvent[], agents: readonly string[], now: number, running: readonly string[] = []): BuildStats {
  const sorted = [...events].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const up: Interval[] = [];
  const runSlots: Record<string, number>[] = []; // each run's slots, as its start logged them (one each before 2026-10-25)
  let opened: { at: number; slots: Record<string, number> } | undefined;
  let lastSeen = 0; // the latest entry of the run that is open, where a run killed without an exit ended
  for (const e of sorted) {
    const t = Date.parse(e.at);
    if (e.kind === 'loop' && e.event === 'start') {
      if (opened) up.push([opened.at, lastSeen]), runSlots.push(opened.slots);
      opened = { at: t, slots: e.slots ?? {} };
    } else if (e.kind === 'loop' && e.event === 'exit') {
      if (opened) up.push([opened.at, t]), runSlots.push(opened.slots);
      opened = undefined;
    }
    lastSeen = t;
  }
  if (opened) up.push([opened.at, now]), runSlots.push(opened.slots);
  const openedAt = opened?.at;
  const firstStart = sorted.find((e) => e.kind === 'loop' && e.event === 'start');
  const end = up.length ? up[up.length - 1]![1] : now;
  const upMs = up.reduce((s, [a, b]) => s + (b - a), 0);

  const usage = agents.map((agent): AgentUsage => {
    const passes = sorted.filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.agent === agent);
    // Every slot is limited from a 'limited' or 'over_budget' event until the next 'available' (a wall outlasts
    // a restart), and the slots its weekly pace holds back are limited until the pace changes or the run ends.
    const changes = sorted.filter((e): e is Extract<LedgerEvent, { kind: 'agent' | 'pace' }> => (e.kind === 'agent' || e.kind === 'pace') && e.agent === agent);
    let walled = false;
    let next = 0;
    let limitedMs = 0;
    let slotMs = 0;
    up.forEach(([from, to], i) => {
      const slots = runSlots[i]![agent] ?? 1;
      slotMs += (to - from) * slots;
      let allowed = slots; // each run paces afresh, and logs its pace only when it holds a slot back
      for (; next < changes.length && Date.parse(changes[next]!.at) <= from; next++) {
        const e = changes[next]!;
        if (e.kind === 'agent') walled = e.state !== 'available';
      }
      let t = from;
      const lost = () => (walled ? slots : Math.max(0, slots - allowed));
      for (; next < changes.length && Date.parse(changes[next]!.at) < to; next++) {
        const e = changes[next]!;
        const at = Date.parse(e.at);
        limitedMs += (at - t) * lost();
        t = at;
        if (e.kind === 'agent') walled = e.state !== 'available';
        else allowed = e.slots;
      }
      limitedMs += (to - t) * lost();
    });
    const lastStart = Math.max(...up.map(([a]) => a), 0);
    const lastPass = Math.max(...passes.map((p) => Date.parse(p.at)), 0);
    const held = running.filter((r) => r === agent).length; // its passes in progress, one per slot it holds
    const current = openedAt !== undefined ? held * (now - Math.max(lastStart, lastPass)) : 0;
    // A pass's duration runs from its claim to its end, so it holds the time its gate took too.
    const gatingMs = passes.reduce((s, p) => s + (p.gateMs ?? 0), 0);
    const workingMs = passes.reduce((s, p) => s + p.durationMs, 0) - gatingMs + current;
    return {
      agent,
      passes: passes.length,
      merged: passes.filter((p) => p.outcome === 'merged').length,
      workingMs,
      gatingMs,
      limitedMs,
      idleMs: Math.max(0, slotMs - workingMs - gatingMs - limitedMs),
      slotMs,
      costUsd: passes.reduce((s, p) => s + (p.costUsd ?? 0), 0),
      tokens: passes.reduce(
        (t, p) => ({ input: t.input + (p.tokens?.input ?? 0), cachedInput: t.cachedInput + (p.tokens?.cachedInput ?? 0), output: t.output + (p.tokens?.output ?? 0) }),
        { input: 0, cachedInput: 0, output: 0 },
      ),
    };
  });
  return {
    startedAt: firstStart?.at,
    elapsedMs: firstStart ? end - Date.parse(firstStart.at) : 0,
    upMs,
    merges: sorted.filter((e) => e.kind === 'merge').length,
    agents: usage,
  };
}

const hm = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
};
const pct = (ms: number, of: number) => (of > 0 ? `${Math.round((ms / of) * 100)}%` : '—');
const mtok = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;

export function formatStats(s: BuildStats, timeZone?: string): string[] {
  if (!s.startedAt) return ['The loop has not started yet.'];
  const started = new Date(s.startedAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
  const out = [`Build started ${started}: ${hm(s.elapsedMs)} elapsed, the loop running for ${hm(s.upMs)}; ${s.merges} tasks merged.`];
  out.push('agent    passes  merged  working          gating           limited          idle             cost      tokens in / cached / out');
  for (const a of s.agents) {
    const cell = (ms: number) => `${hm(ms)} ${pct(ms, a.slotMs)}`.padEnd(17);
    out.push(
      `${a.agent.padEnd(8)} ${String(a.passes).padStart(6)}  ${String(a.merged).padStart(6)}  ${cell(a.workingMs)}${cell(a.gatingMs)}${cell(a.limitedMs)}${cell(a.idleMs)}$${a.costUsd.toFixed(2).padEnd(8)} ${mtok(a.tokens.input)} / ${mtok(a.tokens.cachedInput)} / ${mtok(a.tokens.output)}`,
    );
  }
  return out;
}
