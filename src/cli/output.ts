import type { Change } from '../app/changes.ts';
import { loadConfig, projectInfo } from '../config.ts';
import { Asker } from './ask.ts';
import { UsageError, type Context, type Option } from './command.ts';

// How the commands that list, show and change things print: aligned columns that fit 100, dates in the
// project's time zone, one line per change saying how to undo it, and stable JSON with --json.

export const WIDTH = 100;

// A string cut to `n` characters, with an ellipsis when cut.
export const fit = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, Math.max(0, n - 1))}…`;
};

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Rows as aligned columns; the last column takes what is left of the width, cut to fit.
export function table(rows: string[][], gap = 2): string[] {
  if (!rows.length) return [];
  // A column empty in every row takes no room.
  const empty = new Set(Array.from({ length: Math.max(...rows.map((r) => r.length)) - 1 }, (_, i) => i).filter((i) => rows.every((r) => !r[i])));
  if (empty.size) rows = rows.map((r) => r.filter((_, i) => !empty.has(i)));
  const n = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: n - 1 }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  const lead = widths.reduce((a, w) => a + w + gap, 0);
  return rows.map((r) => {
    const cells = r.slice(0, n - 1).map((c, i) => c.padEnd(widths[i]! + gap)).join('');
    const last = r[n - 1] ?? '';
    return `${cells}${fit(last, Math.max(20, WIDTH - lead))}`.trimEnd();
  });
}

// Text indented under a heading, wrapped at the width on word boundaries.
export function wrap(text: string, indent = 2, width = WIDTH): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    const lead = /^\s*/.exec(para)![0];
    let line = '';
    for (const word of para.trim().split(/\s+/)) {
      if (line && indent + lead.length + line.length + 1 + word.length > width) {
        out.push(`${' '.repeat(indent)}${lead}${line}`);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(`${' '.repeat(indent)}${lead}${line}`);
  }
  return out;
}

export const timeZone = (root: string) => projectInfo(loadConfig(root)).timezone;

// A date as a short day, in the project's time zone: "Tue, Oct 27".
export const day = (ms: number, tz?: string) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });

// How long ago, in the largest unit that fits: "3 min ago", "2 h ago", "4 d ago".
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} d`);
export const usd = (n: number) => `$${Number.isInteger(n) ? n.toLocaleString('en-US') : n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;

export const json = (ctx: Context, value: unknown) => ctx.out(JSON.stringify(value, null, 2));

// What an undoable change prints after its line: how to undo it, or nothing when it made no commit.
export const undoHint = (change?: Change) => (change ? ` Undo: helix-loop undo ${change.id}` : '');

// The confirmation the app asks for before something hard to take back: --yes, or a question at a terminal.
export const YES: Record<string, Option> = { yes: { type: 'boolean', short: 'y', description: 'Go ahead without asking first' } };

export async function confirm(ctx: Context, question: string, details: string[] = []): Promise<void> {
  if (ctx.opts.yes === true) return;
  if (!ctx.interactive) throw new UsageError(`${question} Add --yes to go ahead.`);
  for (const d of details) ctx.out(d);
  const a = new Asker();
  try {
    if (!(await a.yes(question, false))) throw new UsageError('Nothing changed.');
  } finally {
    a.close();
  }
}

// A value a command line holds, as the config wants it: true and false, numbers, lists in commas, or text.
export function parseWord(s: string): unknown {
  if (/^(true|on|yes)$/i.test(s)) return true;
  if (/^(false|off|no)$/i.test(s)) return false;
  if (/^(null|default)$/i.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[[{]/.test(s.trim())) {
    try {
      return JSON.parse(s);
    } catch {
      // as text
    }
  }
  return s;
}
