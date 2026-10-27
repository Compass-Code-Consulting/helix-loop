import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentName, Task } from '../types.ts';

// Comments and Helix's conversations (spec §9.4), one append-only file per target: runs/threads/<target>.jsonl.
// A target is a task, a human task, a dependency edge ("T-1200~T-1180": T-1200 waits on T-1180), or a
// conversation of its own ("S-3"), started from Ask Helix about anything in the loop or a selection on Home. Comments
// come in two levels: root comments, and replies one level under a root. Each root comment starts its own
// thread, keyed by target and root ("T-0034#c3"); a reply under a root belongs to that root's thread, and a new
// root comment never reopens an older thread. The latest `state` entry of a thread wins, so nothing is rewritten.

export type Author = 'daniel' | 'helix';
export type EntryKind = 'comment' | 'reply' | 'message' | 'summary' | 'proposal' | 'decision' | 'state';

export interface Entry {
  id: string;
  thread: string; // the root comment's id
  parent: string | null; // null for a root comment; the root's id for a reply, a summary or a thread entry
  author: Author;
  at: string;
  kind: EntryKind;
  text: string;
  state?: 'open' | 'resolved'; // kind state
  session?: string; // kind state: Helix's session, resumed on its next turn
  agent?: AgentName; // kind state: which CLI holds that session
  task?: Partial<Task>; // kind proposal: a task Helix proposes to create
  proposal?: string; // kind decision: the proposal decided
  decision?: 'accepted' | 'declined'; // kind decision
}

export interface Thread {
  key: string; // `${target}#${root}`
  target: string;
  root: Entry;
  replies: Entry[]; // under the root comment in the detail panel: Daniel's replies and Helix's summaries
  messages: Entry[]; // the sidebar conversation: messages, proposals and decisions, in order
  state: 'open' | 'resolved';
  waitingOn: 'helix' | 'daniel' | null; // who speaks next while it is open
  session?: string;
  agent?: AgentName;
}

const TARGET = /^((T-\d{4}|HT-\d+)(~(T-\d{4}|HT-\d+))?|S-\d+)$/;
export const isTarget = (s: string) => TARGET.test(s);
export const threadKey = (target: string, root: string) => `${target}#${root}`;

export function parseKey(key: string): { target: string; root: string } | undefined {
  const [target, root] = key.split('#');
  return target && root && isTarget(target) && /^c\d+$/.test(root) ? { target, root } : undefined;
}

const file = (dir: string, target: string) => join(dir, `${target}.jsonl`);

export function readEntries(dir: string, target: string): Entry[] {
  if (!isTarget(target) || !existsSync(file(dir, target))) return [];
  return readFileSync(file(dir, target), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        // Before Helix was named, it signed as the steward.
        const e = JSON.parse(l) as Omit<Entry, 'author'> & { author: string };
        if (e.author === 'steward') e.author = 'helix';
        return [e as Entry];
      } catch {
        return []; // a line cut short by a crash
      }
    });
}

export class ThreadError extends Error {}

// Appends one entry. Ids are per target, by kind: c1, c2 for root comments, then r, m, s, p, d, x.
function append(dir: string, target: string, e: Omit<Entry, 'id' | 'at'> & { at?: string }): Entry {
  if (!isTarget(target)) throw new ThreadError(`not a task, human task or dependency: ${target}`);
  const existing = readEntries(dir, target);
  const prefix = { comment: 'c', reply: 'r', message: 'm', summary: 's', proposal: 'p', decision: 'd', state: 'x' }[e.kind];
  const n = existing.filter((x) => x.id.startsWith(prefix)).length + 1;
  const id = `${prefix}${n}`;
  // A root comment's thread is its own id.
  const entry: Entry = { ...e, id, thread: e.kind === 'comment' ? id : e.thread, at: e.at ?? new Date().toISOString() } as Entry;
  mkdirSync(dir, { recursive: true });
  appendFileSync(file(dir, target), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function threadsOf(target: string, entries: Entry[]): Thread[] {
  const roots = entries.filter((e) => e.kind === 'comment');
  return roots.map((root) => {
    const own = entries.filter((e) => e.thread === root.id && e !== root);
    const states = own.filter((e) => e.kind === 'state');
    const last = states.at(-1);
    const messages = own.filter((e) => e.kind === 'message' || e.kind === 'proposal' || e.kind === 'decision');
    const state = last?.state ?? 'open';
    const speaker = messages.filter((m) => m.kind !== 'decision').at(-1)?.author;
    return {
      key: threadKey(target, root.id),
      target,
      root,
      replies: own.filter((e) => e.kind === 'reply' || e.kind === 'summary'),
      messages,
      state,
      waitingOn: state === 'resolved' ? null : speaker === 'helix' ? 'daniel' : 'helix',
      session: [...states].reverse().find((s) => s.session)?.session,
      agent: [...states].reverse().find((s) => s.agent)?.agent,
    };
  });
}

export function thread(dir: string, key: string): Thread | undefined {
  const k = parseKey(key);
  if (!k) return undefined;
  return threadsOf(k.target, readEntries(dir, k.target)).find((t) => t.root.id === k.root);
}

// Every thread of every target, open first, then newest.
export function allThreads(dir: string): Thread[] {
  if (!existsSync(dir)) return [];
  const out = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => {
      const target = f.slice(0, -'.jsonl'.length);
      return threadsOf(target, readEntries(dir, target));
    });
  const lastAt = (t: Thread) => [t.root, ...t.messages, ...t.replies].reduce((m, e) => (e.at > m ? e.at : m), '');
  return out.sort((a, b) => (a.state === b.state ? lastAt(b).localeCompare(lastAt(a)) : a.state === 'open' ? -1 : 1));
}

const clean = (text: string) => {
  const t = text.trim();
  if (!t) throw new ThreadError('a comment needs some text');
  if (t.length > 8000) throw new ThreadError('a comment is at most 8,000 characters');
  return t;
};

// A root comment: it stays in the detail panel, and starts a thread whose first message is a copy of it.
export function addComment(dir: string, target: string, text: string): Thread {
  const body = clean(text);
  const root = append(dir, target, { thread: '', parent: null, author: 'daniel', kind: 'comment', text: body });
  append(dir, target, { thread: root.id, parent: root.id, author: 'daniel', kind: 'message', text: body });
  append(dir, target, { thread: root.id, parent: root.id, author: 'daniel', kind: 'state', text: '', state: 'open' });
  return thread(dir, threadKey(target, root.id))!;
}

// A reply under a root comment belongs to that root's thread: it is copied there, and reopens it if resolved.
export function addReply(dir: string, target: string, parent: string, text: string): Thread {
  const body = clean(text);
  const t = threadsOf(target, readEntries(dir, target)).find((x) => x.root.id === parent);
  if (!t) throw new ThreadError(`${parent} is not a root comment on ${target}; replies go one level deep`);
  append(dir, target, { thread: parent, parent, author: 'daniel', kind: 'reply', text: body });
  append(dir, target, { thread: parent, parent, author: 'daniel', kind: 'message', text: body });
  if (t.state === 'resolved') append(dir, target, { thread: parent, parent, author: 'daniel', kind: 'state', text: '', state: 'open' });
  return thread(dir, t.key)!;
}

export function addMessage(dir: string, key: string, author: Author, text: string): Thread {
  const t = mustThread(dir, key);
  append(dir, t.target, { thread: t.root.id, parent: t.root.id, author, kind: 'message', text: author === 'daniel' ? clean(text) : text.trim() });
  if (t.state === 'resolved' && author === 'daniel') append(dir, t.target, { thread: t.root.id, parent: t.root.id, author, kind: 'state', text: '', state: 'open' });
  return thread(dir, key)!;
}

export function setSession(dir: string, key: string, agent: AgentName, session: string): void {
  const t = mustThread(dir, key);
  if (t.session === session && t.agent === agent) return;
  append(dir, t.target, { thread: t.root.id, parent: t.root.id, author: 'helix', kind: 'state', text: '', state: t.state, session, agent });
}

export function addProposal(dir: string, key: string, text: string, task: Partial<Task>): Entry {
  const t = mustThread(dir, key);
  return append(dir, t.target, { thread: t.root.id, parent: t.root.id, author: 'helix', kind: 'proposal', text, task });
}

export function decide(dir: string, key: string, proposal: string, decision: 'accepted' | 'declined', text: string): void {
  const t = mustThread(dir, key);
  if (!t.messages.some((m) => m.kind === 'proposal' && m.id === proposal)) throw new ThreadError(`no proposal ${proposal} in ${key}`);
  if (t.messages.some((m) => m.kind === 'decision' && m.proposal === proposal)) throw new ThreadError(`${proposal} is already decided`);
  append(dir, t.target, { thread: t.root.id, parent: t.root.id, author: 'daniel', kind: 'decision', text, proposal, decision });
}

// The summary goes under the root comment, signed by Helix, and the thread is resolved.
export function resolveThread(dir: string, key: string, summary: string): Thread {
  const t = mustThread(dir, key);
  append(dir, t.target, { thread: t.root.id, parent: t.root.id, author: 'helix', kind: 'summary', text: summary.trim() });
  append(dir, t.target, { thread: t.root.id, parent: t.root.id, author: 'helix', kind: 'state', text: '', state: 'resolved' });
  return thread(dir, key)!;
}

function mustThread(dir: string, key: string): Thread {
  const t = thread(dir, key);
  if (!t) throw new ThreadError(`no thread ${key}`);
  return t;
}

// A new conversation of its own, for Ask Helix: the next free S-<n>.
export function newConversationTarget(dir: string): string {
  if (!existsSync(dir)) return 'S-1';
  const n = readdirSync(dir).map((f) => /^S-(\d+)\.jsonl$/.exec(f)?.[1]).filter(Boolean).map(Number);
  return `S-${Math.max(0, ...n) + 1}`;
}
