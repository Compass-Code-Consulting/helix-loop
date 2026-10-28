import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import { builderEnv } from '../agents/adapter.ts';
import { loadConfig, logFile, monitorModel, monitorOf, paths, type Config } from '../config.ts';
import { readLedger } from '../ledger.ts';
import { hashToken, newToken } from '../live.ts';
import { membership } from '../plan/milestones.ts';
import { loadPlan } from '../plan/store.ts';
import { trailOf } from '../plan/taskset.ts';
import { run } from '../proc.ts';
import { loadIndex, sliceSection } from '../spec/index.ts';
import type { AgentName, Task } from '../types.ts';
import { PlanEditError, STEWARD_HUMAN_FIELDS, STEWARD_TASK_FIELDS, updateHuman, updateTask } from './actions.ts';
import { buildBoard } from './board.ts';
import { applyChanges } from './fixes.ts';
import { health, KEY_ENV, readKey } from './health.ts';
import { appendHitl, decide, pilotOf, readHitl, readRules, REQUESTS, type RequestKind } from './hitl.ts';
import { appendStored, incidents as findIncidents, readStored, type Fix, type Incident, type PlanChange } from './incidents.ts';
import { str, ToolError, type Tool } from './mcp.ts';
import { fillPrompt, monitorPromptName, ownerOf, readPrompt } from './prompts.ts';
import { loopStatus, mapModel, readReports } from './state.ts';
import { addMessage, addProposal, resolveThread, setSession, thread, type Thread } from './threads.ts';
import { boardInput } from './views.ts';

// Helix (spec §9): the loop's assistant, run as Claude Code or Codex, headless, one turn at a time, with no
// built-in tools. Everything it can do is a tool below on the app's /mcp/helix endpoint, so its limits are the
// app's, not its prompts': it reads the plan, the spec and the logs, and changes only what these tools allow,
// after the app's checks. It runs from a folder outside the control plane, so no project instructions reach it.
//
// It has two roles, with separate sessions, prompts and tools. The assistant answers the owner in conversations
// and makes the plan changes they ask for (it was the steward). The monitor watches the loop: from a digest the
// app prepares, it names and merges incidents, proposes one fix for each, resolves what the pilot level lets it
// resolve, and brings the owner the rest. Its turns draw on a subscription, so it is off until the owner turns it on.

export type HelixRole = 'assistant' | 'monitor';

export interface HelixJob {
  role: HelixRole;
  key?: string; // the assistant's thread
  focus?: string; // the monitor's: an incident the owner asked about ("Ask Helix to revise")
  root: string;
  tokenHash: string;
  startedAt: string;
  resolved: boolean; // resolve_thread was called during this turn
}

export interface HelixContext {
  root: string;
  job: HelixJob;
}

const json = (v: unknown) => stringify(v, { lineWidth: 0 });

function planOf(root: string) {
  const p = paths(root);
  return loadPlan(p.tasks, p.human);
}

function targetLabel(target: string): string {
  const [a, b] = target.split('~');
  if (a!.startsWith('S-')) return 'anything in the loop (see the comment)';
  return b ? `the dependency "${a} waits on ${b}"` : a!.startsWith('HT-') ? `human task ${a}` : `task ${a}`;
}

export const ASSISTANT_TOOLS: Tool<HelixContext>[] = [
  {
    name: 'get_task',
    description: 'One task (T-####) or human task (HT-##): every field, its attempts and notes, and where it sits in the dependency map (earliest start, slack, critical path, what it waits on and what waits on it).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    call: (args, { root }) => {
      const id = str(args, 'id', 20)!;
      const plan = planOf(root);
      const value = plan.tasks.get(id) ?? plan.human.get(id);
      if (!value) throw new ToolError(`no task ${id}`);
      const config = loadConfig(root);
      const node = mapModel(root, plan, readLedger(paths(root).ledger), config).nodes.find((n) => n.id === id);
      const where = node && { critical: node.critical, slack_hours: Math.round(node.slack * 10) / 10, earliest_start_hours: Math.round(node.es * 10) / 10, waits_on: node.blockedBy, waited_on_by: node.dependents, latest_start: node.latestStart };
      return json({ ...value, handoff_prompt: undefined, map: where });
    },
  },
  {
    name: 'find_tasks',
    description: 'Tasks matching every filter given: text in the id, title or summary; area; under (a story, feature, epic or lane key: the tasks under it); repo; milestone (its key); status. At most 40, each as one line.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, area: { type: 'string' }, under: { type: 'string' }, repo: { type: 'string' }, milestone: { type: 'string' }, status: { type: 'string' } },
      additionalProperties: false,
    },
    call: (args, { root }) => {
      const f = (k: string) => str(args, k, 200, false)?.toLowerCase();
      const [text, area, under, repo, milestone, status] = ['text', 'area', 'under', 'repo', 'milestone', 'status'].map(f);
      const plan = planOf(root);
      const member = membership(plan);
      const trail = (story: string) => {
        const t = trailOf(plan.taskset, story);
        return [t.story?.key, t.feature?.key, t.epic?.key, t.lane?.key];
      };
      const hits = [...plan.tasks.values()].filter(
        (t) =>
          (!text || `${t.id} ${t.title} ${t.summary ?? ''}`.toLowerCase().includes(text)) &&
          (!area || t.area.toLowerCase().includes(area)) &&
          (!under || trail(t.story).includes(under)) &&
          (!repo || t.repo === repo) &&
          (!milestone || member.of.get(t.id) === milestone) &&
          (!status || t.status === status),
      );
      const human = text ? [...plan.human.values()].filter((h) => `${h.id} ${h.title}`.toLowerCase().includes(text)) : [];
      const lines = [...hits.map((t) => `${t.id} [${t.status}] ${t.story} ${t.area}: ${t.title}`), ...human.map((h) => `${h.id} [${h.status}] human: ${h.title}`)];
      return lines.length ? `${lines.slice(0, 40).join('\n')}${lines.length > 40 ? `\n… and ${lines.length - 40} more; narrow the filters` : ''}` : 'No task matches.';
    },
  },
  {
    name: 'get_attempt_log',
    description: "The last 200 lines of one attempt's log (the agent's output and the gate's), to see why it failed. Attempts are numbered from 1.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, attempt: { type: 'integer', minimum: 1 } }, required: ['id', 'attempt'], additionalProperties: false },
    call: (args, { root }) => {
      const id = str(args, 'id', 20)!;
      const t = planOf(root).tasks.get(id);
      const a = t?.attempts[Number(args.attempt) - 1];
      if (!a?.log) throw new ToolError(`${id} has no log for attempt ${String(args.attempt)}`);
      const file = logFile(root, a.log);
      if (!existsSync(file)) throw new ToolError(`the log ${a.log} is gone`);
      const text = (a.log.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString('utf8');
      return text.split('\n').slice(-200).join('\n').slice(-30_000);
    },
  },
  {
    name: 'loop_status',
    description: "The loop now: whether it runs, its mode, each agent's state, task counts and the projected finish: project complete (everything done, human tasks taking their lead times) and, when the TaskSet shows it, code complete (the last builder task merged, as if every human task were done when needed).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: (_args, { root }) => {
      const events = readLedger(paths(root).ledger);
      const plan = planOf(root);
      const config = loadConfig(root);
      const m = mapModel(root, plan, events, config);
      const board = buildBoard(boardInput(root, plan, events, config, Date.now()));
      const iso = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());
      return json({ loop: loopStatus(root, events), agents: m.agents, totals: m.totals, code_complete: iso(board.codeFinish), project_complete: iso(board.finish), critical_path: m.criticalPath.slice(0, 30) });
    },
  },
  {
    name: 'spec_sections',
    description: 'The spec sections tasks can cite, with their sizes in bytes; a filter narrows them by key.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, additionalProperties: false },
    call: (args, { root }) => {
      const filter = (str(args, 'filter', 100, false) ?? '').toLowerCase();
      const p = paths(root);
      const index = loadIndex(p.specIndex);
      const rows = Object.values(index.sections)
        .filter((s) => !filter || s.key.toLowerCase().includes(filter) || s.title.toLowerCase().includes(filter))
        .map((s) => `${s.key}: ${s.title}`);
      return rows.slice(0, 120).join('\n') || 'No section matches.';
    },
  },
  {
    name: 'get_spec_section',
    description: "One spec section's text, by its key (\"§11 Composer\") or a requirement ID (\"PB-14\").",
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    call: (args, { root }) => {
      const key = str(args, 'key', 200)!;
      const p = paths(root);
      const index = loadIndex(p.specIndex);
      const req = index.reqs[key];
      const s = index.sections[key] ?? (req ? index.sections[req.subsection ?? req.section] : undefined);
      if (!s) throw new ToolError(`no spec section or requirement ${key}; spec_sections lists them`);
      return sliceSection(p.specSections, s).slice(0, 40_000);
    },
  },
  {
    name: 'update_task',
    description: `Change a task that the loop is not running. Only these fields: ${STEWARD_TASK_FIELDS.join(', ')}; status only to ready (hand it back) or parked. Give each field its whole new value; for notes, keep what is there and add to it unless the owner asks to replace it. The change is validated against the schema and the dependency graph before it lands, then committed.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        changes: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            acceptance: { type: 'array', items: { type: 'string' } },
            blocked_by: { type: 'array', items: { type: 'string' } },
            estimate_passes: { type: 'number' },
            priority: { enum: ['fix_first', 'normal'] },
            agent: { enum: ['claude', 'codex'] },
            notes: { type: 'string' },
            status: { enum: ['ready', 'parked'] },
          },
          additionalProperties: false,
        },
        why: { type: 'string', description: 'One line for the commit message.' },
      },
      required: ['id', 'changes', 'why'],
      additionalProperties: false,
    },
    call: async (args, { root, job }) => {
      const id = str(args, 'id', 20)!;
      const why = str(args, 'why', 200)!;
      try {
        const r = await updateTask(root, id, (args.changes ?? {}) as Partial<Task>, { fields: STEWARD_TASK_FIELDS, message: `Plan: ${id}: ${why} (Helix assistant, thread ${job.key})` });
        return `${id} changed${r.committed ? ' and committed' : ''}.`;
      } catch (e) {
        if (e instanceof PlanEditError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: 'update_human_task',
    description: `Change a human task. Only these fields: ${STEWARD_HUMAN_FIELDS.join(', ')}. Validated, then committed.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        changes: {
          type: 'object',
          properties: { status: { enum: ['todo', 'in_progress', 'done'] }, blocked_by: { type: 'array', items: { type: 'string' } }, lead_time_days: { type: 'number' }, notes: { type: 'string' } },
          additionalProperties: false,
        },
        why: { type: 'string' },
      },
      required: ['id', 'changes', 'why'],
      additionalProperties: false,
    },
    call: async (args, { root, job }) => {
      const id = str(args, 'id', 20)!;
      const why = str(args, 'why', 200)!;
      try {
        const r = await updateHuman(root, id, (args.changes ?? {}) as Record<string, unknown>, { fields: STEWARD_HUMAN_FIELDS, message: `Plan: ${id}: ${why} (Helix assistant, thread ${job.key})` });
        return `${id} changed${r.committed ? ' and committed' : ''}.`;
      } catch (e) {
        if (e instanceof PlanEditError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: 'propose_task',
    description:
      'Propose a new task, for example one half of a split. the owner accepts or declines it in the app; nothing is created until they accept. Give repo, story (one the TaskSet declares, in the lane that builds the repo), area, title, reqs, spec, acceptance, blocked_by and estimate_passes as a planner would.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'object',
          properties: {
            repo: { type: 'string' }, story: { type: 'string' }, area: { type: 'string' }, title: { type: 'string' },
            reqs: { type: 'array', items: { type: 'string' } }, spec: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } },
            blocked_by: { type: 'array', items: { type: 'string' } }, estimate_passes: { type: 'number' }, priority: { enum: ['fix_first', 'normal'] }, agent: { enum: ['claude', 'codex'] }, notes: { type: 'string' },
          },
          required: ['repo', 'story', 'area', 'title', 'reqs', 'spec', 'acceptance', 'blocked_by', 'estimate_passes'],
          additionalProperties: false,
        },
        why: { type: 'string', description: 'One sentence the owner reads beside the proposal.' },
      },
      required: ['task', 'why'],
      additionalProperties: false,
    },
    call: (args, { root, job }) => {
      const why = str(args, 'why', 500)!;
      const task = args.task as Partial<Task>;
      if (!task || typeof task !== 'object') throw new ToolError('task is required');
      const e = addProposal(paths(root).threads, job.key!, why, task);
      return `Proposed as ${e.id}; the owner accepts or declines it in the thread.`;
    },
  },
  {
    name: 'resolve_thread',
    description: 'Close this thread once the owner has read your answer and it is settled, or when they ask you to. Never on your first answer. The summary, at most three sentences, goes under the owner\'s comment: what was decided and each change with its task ID.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string', maxLength: 600 } }, required: ['summary'], additionalProperties: false },
    call: (args, { root, job }) => {
      // Answer first: a thread is resolved only once the owner has read an answer, or when they pressed Resolve.
      const t = thread(paths(root).threads, job.key!);
      const answered = t?.messages.some((m) => m.author === 'helix' && m.kind === 'message');
      const asked = t?.messages.findLast((m) => m.author === 'owner' && m.kind === 'message')?.text === RESOLVE_REQUEST;
      if (!answered && !asked) throw new ToolError('Not yet: answer the owner first, in plain words, and leave the thread open. Do not mention this to them.');
      resolveThread(paths(root).threads, job.key!, str(args, 'summary', 600)!);
      job.resolved = true;
      return 'Resolved; the summary is under the comment.';
    },
  },
];


// ---- the monitor's tools ----

const READING = ['get_task', 'find_tasks', 'get_attempt_log', 'loop_status', 'spec_sections', 'get_spec_section'];

function incidentsOf(root: string): Incident[] {
  const p = paths(root);
  return findIncidents({ plan: planOf(root), events: readLedger(p.ledger), reports: readReports(root), stored: readStored(p.incidents), now: Date.now() });
}

// The table row an incident's decision falls under.
export function requestOf(inc: Pick<Incident, 'kind'>): RequestKind {
  switch (inc.kind) {
    case 'spec_question':
      return 'spec_plain';
    case 'scope_grew':
      return 'scope';
    case 'credential_missing':
    case 'blocked_on_human':
      return 'human_done'; // only the owner can add a secret or do a human task
    default:
      return 'failures';
  }
}

const CHANGE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      op: { enum: ['hand_back', 'park', 'note', 'add_dep', 'remove_dep', 'new_task', 'pause'] },
      task: { description: 'A task id; for new_task, the new task as a planner writes it (repo, story, area, title, reqs, spec, acceptance, blocked_by, estimate_passes, priority).' },
      note: { type: 'string' },
      on: { type: 'string', description: 'add_dep, remove_dep: the task or human task it waits on' },
      ref: { type: 'string', description: 'new_task: a name such as "new:1" other changes may use as its id' },
    },
    required: ['op'],
  },
};

function changesArg(args: Record<string, unknown>): PlanChange[] {
  const raw = args.changes;
  if (!Array.isArray(raw)) throw new ToolError('changes is a list');
  return raw.map((c: Record<string, unknown>) => {
    const op = String(c.op);
    if (op === 'pause') return { op };
    if (op === 'new_task') {
      if (!c.task || typeof c.task !== 'object') throw new ToolError('new_task needs task, the new task as a planner writes it');
      return { op, task: c.task as Record<string, unknown>, ref: typeof c.ref === 'string' ? c.ref : undefined };
    }
    if (typeof c.task !== 'string') throw new ToolError(`${op} needs task, a task id`);
    if (op === 'add_dep' || op === 'remove_dep') {
      if (typeof c.on !== 'string') throw new ToolError(`${op} needs on`);
      return { op, task: c.task, on: c.on };
    }
    if (op === 'note' && typeof c.note !== 'string') throw new ToolError('note needs note');
    if (!['hand_back', 'park', 'note'].includes(op)) throw new ToolError(`unknown op ${op}`);
    return { op, task: c.task, note: typeof c.note === 'string' ? c.note.slice(0, 2000) : undefined } as PlanChange;
  });
}

const confidence = (args: Record<string, unknown>) => {
  const c = Number(args.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 100) throw new ToolError('confidence is a percentage, 0 to 100');
  return c / 100;
};

// Whether the pilot level and the rules let Helix decide this request itself.
function allowed(root: string, request: RequestKind, name?: string): { ok: boolean; why: string; parks: boolean } {
  const config = loadConfig(root);
  const pilot = pilotOf(config);
  const { decision, rule } = decide(pilot, readRules(root), request, name);
  const level = pilot.mode === 'auto' ? `Auto-pilot · ${pilot.auto_level}` : `Active pilot · ${pilot.active_level}`;
  if (decision === 'helix') return { ok: true, why: rule ? `The owner's rule: decide "${rule.name}" yourself` : level, parks: false };
  if (decision === 'parks') return { ok: false, why: `On ${level} you park this kind instead: park the task with a note saying what the owner must decide`, parks: true };
  return { ok: false, why: rule ? `The owner's rule: always ask about "${rule.name}". Use raise_request.` : `On ${level} the owner decides this kind. Use raise_request.`, parks: false };
}

export const MONITOR_TOOLS: Tool<HelixContext>[] = [
  ...ASSISTANT_TOOLS.filter((t) => READING.includes(t.name)),
  {
    name: 'get_incident',
    description: 'One incident by its key: its kind, cause, every task in it with its count and latest failure, when it happened, the fix proposed and what the owner decided.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    call: (args, { root }) => {
      const key = str(args, 'key', 400)!;
      const inc = incidentsOf(root).find((i) => i.key === key);
      if (!inc) throw new ToolError(`no incident ${key}; the digest lists them`);
      return json({ ...inc, times: undefined, hours: inc.times.map((t) => new Date(t).toISOString().slice(0, 13)) });
    },
  },
  {
    name: 'group_feedback',
    description: 'Name an incident in one line for the owner, and merge into it the incidents whose cause is the same though their text differs.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string', maxLength: 120 }, merge: { type: 'array', items: { type: 'string' } } }, required: ['key', 'title'], additionalProperties: false },
    call: (args, { root }) => {
      const key = str(args, 'key', 400)!;
      const all = incidentsOf(root);
      if (!all.some((i) => i.key === key)) throw new ToolError(`no incident ${key}`);
      const merge = Array.isArray(args.merge) ? args.merge.map(String).filter((k) => k !== key && all.some((i) => i.key === k)) : [];
      appendStored(paths(root).incidents, { type: 'named', key, at: new Date().toISOString(), title: str(args, 'title', 120)!, merged: merge });
      return `Named${merge.length ? `, with ${merge.length} merged in` : ''}.`;
    },
  },
  {
    name: 'propose_fix',
    description: 'Propose exactly one fix for an incident: plan changes applied together as one commit when the owner accepts (or when you may apply it yourself, with apply_fix). For a spec question, give answer: the answer every task in it gets in its notes, and the spec sections you read.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        summary: { type: 'string', maxLength: 200, description: 'What the fix does, in one line.' },
        confidence: { type: 'number', description: 'How sure you are, as a percentage.' },
        changes: CHANGE_SCHEMA,
        alternatives: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, cost: { type: 'string' } }, required: ['title', 'cost'] } },
        evidence: { type: 'string', maxLength: 600, description: 'The counts or facts that point to the cause.' },
        answer: { type: 'string', maxLength: 3000 },
        sections: { type: 'array', items: { type: 'string' } },
      },
      required: ['key', 'summary', 'confidence', 'changes'],
      additionalProperties: false,
    },
    call: (args, { root }) => {
      const key = str(args, 'key', 400)!;
      if (!incidentsOf(root).some((i) => i.key === key)) throw new ToolError(`no incident ${key}`);
      const changes = changesArg(args);
      const n = readStored(paths(root).incidents).filter((s) => s.type === 'fix').length + 1;
      const answer = str(args, 'answer', 3000, false);
      const fix: Fix = {
        id: `F-${n}`,
        at: new Date().toISOString(),
        by: 'helix',
        summary: str(args, 'summary', 200)!,
        confidence: confidence(args),
        changes,
        alternatives: Array.isArray(args.alternatives) ? (args.alternatives as { title: string; cost: string }[]).slice(0, 4).map((a) => ({ title: String(a.title).slice(0, 120), cost: String(a.cost).slice(0, 160) })) : undefined,
        evidence: str(args, 'evidence', 600, false),
        ...(answer ? { answer: { text: answer, sections: Array.isArray(args.sections) ? args.sections.map(String).slice(0, 8) : [] } } : {}),
      };
      appendStored(paths(root).incidents, { type: 'fix', key, fix });
      return `Proposed as ${fix.id}.`;
    },
  },
  {
    name: 'apply_fix',
    description: "Apply the fix you proposed for an incident yourself. Refused unless the pilot level and the owner's rules let you decide that kind of request; then it waits for the owner. Records what you did for them to review.",
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, question: { type: 'string', description: 'The request as it would have been put to the owner.' }, why: { type: 'string' } }, required: ['key', 'question', 'why'], additionalProperties: false },
    call: async (args, { root }) => {
      const key = str(args, 'key', 400)!;
      const inc = incidentsOf(root).find((i) => i.key === key);
      if (!inc?.fix) throw new ToolError(`no fix proposed for ${key}`);
      if (inc.decision) throw new ToolError(`the owner already ${inc.decision.decision} this fix`);
      const request = requestOf(inc);
      const a = allowed(root, request, inc.title);
      if (!a.ok) throw new ToolError(`Not yours to decide: ${a.why}`);
      return applyAndRecord(root, { request, name: inc.title ?? inc.cause, tasks: inc.members.map((m) => m.task), question: str(args, 'question', 400)!, chose: inc.fix.summary, why: str(args, 'why', 400)!, confidence: inc.fix.confidence, changes: inc.fix.changes, incident: key, fixId: inc.fix.id });
    },
  },
  {
    name: 'resolve_hitl',
    description: "Resolve a request the loop would put to the owner (a builder unsure how to go on, a question, a task that grew, a repeated failure) by applying plan changes yourself. Refused unless the pilot level and the owner's rules let you decide that kind; on Auto-pilot some kinds may only be parked. Name the kind of request in a few words (\"lockfile-only merge conflicts\"): the owner's ratings attach to that name.",
    inputSchema: {
      type: 'object',
      properties: {
        request: { enum: REQUESTS.map((r) => r.kind) },
        name: { type: 'string', maxLength: 80 },
        tasks: { type: 'array', items: { type: 'string' } },
        question: { type: 'string', description: 'The request as it would have been put to the owner.' },
        chose: { type: 'string', description: 'What you did, in one line.' },
        why: { type: 'string' },
        confidence: { type: 'number' },
        changes: CHANGE_SCHEMA,
      },
      required: ['request', 'name', 'tasks', 'question', 'chose', 'why', 'confidence', 'changes'],
      additionalProperties: false,
    },
    call: async (args, { root }) => {
      const request = String(args.request) as RequestKind;
      if (!REQUESTS.some((r) => r.kind === request)) throw new ToolError('request is one of the table\'s kinds');
      const name = str(args, 'name', 80)!;
      const changes = changesArg(args);
      const a = allowed(root, request, name);
      const parksOnly = !a.ok && a.parks && changes.every((c) => c.op === 'park' || c.op === 'note');
      if (!a.ok && !parksOnly) throw new ToolError(`Not yours to decide: ${a.why}`);
      return applyAndRecord(root, { request, name, tasks: Array.isArray(args.tasks) ? args.tasks.map(String) : [], question: str(args, 'question', 400)!, chose: str(args, 'chose', 200)!, why: str(args, 'why', 400)!, confidence: confidence(args), changes });
    },
  },
  {
    name: 'raise_request',
    description: 'Bring the owner a request you may not decide: the question, two or three options as plan changes, and the one you would pick. It waits on Home; the tasks wait for them.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { enum: REQUESTS.map((r) => r.kind) },
        name: { type: 'string', maxLength: 80 },
        tasks: { type: 'array', items: { type: 'string' } },
        question: { type: 'string', maxLength: 300 },
        why: { type: 'string', maxLength: 300 },
        options: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string', maxLength: 40 }, changes: CHANGE_SCHEMA }, required: ['label', 'changes'] } },
        recommend: { type: 'integer', minimum: 0 },
      },
      required: ['request', 'name', 'tasks', 'question', 'options'],
      additionalProperties: false,
    },
    call: (args, { root }) => {
      const file = paths(root).hitl;
      const { raised } = readHitl(file);
      const tasks = Array.isArray(args.tasks) ? args.tasks.map(String) : [];
      if (raised.some((r) => !r.answered && r.tasks.join() === tasks.join() && r.request === args.request)) return 'Already waiting for the owner.';
      const options = (args.options as { label: string; changes: unknown }[]).map((o) => ({ label: String(o.label).slice(0, 40), changes: changesArg({ changes: o.changes }) }));
      const id = `Q-${raised.length + 1}`;
      appendHitl(file, { type: 'raised', id, at: new Date().toISOString(), request: args.request as RequestKind, name: str(args, 'name', 80)!, tasks, question: str(args, 'question', 300)!, why: str(args, 'why', 300, false), options, recommend: Number.isInteger(args.recommend) ? Number(args.recommend) : undefined });
      return `Raised as ${id}; it waits for the owner on Home.`;
    },
  },
  {
    name: 'note_tasks',
    description: "Add a note to the notes of tasks waiting on a human task the owner just finished: what their builders need from it, such as an ID or a URL. Never a secret's value, only its name and where it is stored. Only tasks that wait on that human task, and only notes.",
    inputSchema: { type: 'object', properties: { human: { type: 'string', description: 'The human task the owner marked done (HT-##).' }, tasks: { type: 'array', items: { type: 'string' } }, note: { type: 'string', maxLength: 1000 } }, required: ['human', 'tasks', 'note'], additionalProperties: false },
    call: async (args, { root }) => {
      const id = str(args, 'human', 20)!;
      const plan = planOf(root);
      if (plan.human.get(id)?.status !== 'done') throw new ToolError(`${id} isn't done; notes from it wait until the owner marks it done`);
      const tasks = (Array.isArray(args.tasks) ? args.tasks.map(String) : []).filter((t) => plan.tasks.get(t)?.blocked_by.includes(id));
      if (!tasks.length) throw new ToolError(`none of those tasks waits on ${id}`);
      const note = str(args, 'note', 1000)!;
      try {
        const r = await applyChanges(root, tasks.map((task) => ({ op: 'note', task, note: `From ${id}: ${note}` }) as PlanChange), { what: `notes from ${id} for ${tasks.length} task${tasks.length === 1 ? '' : 's'}`, by: 'Helix monitor', source: id });
        return `Noted on ${r.tasks.join(', ')}.`;
      } catch (e) {
        if (e instanceof PlanEditError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: 'note_pass',
    description: "Your one-line read of a running pass, shown beside it in Live as \"Helix is watching\": how it compares with the last attempt, whether it will finish inside the timeout.",
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, text: { type: 'string', maxLength: 240 } }, required: ['task', 'text'], additionalProperties: false },
    call: (args, { root }) => {
      appendReads(root, { task: str(args, 'task', 20)!, text: str(args, 'text', 240)! });
      return 'Shown in Live.';
    },
  },
];

// The monitor's tools at its level: light asks for no reads of running passes, so it is not offered note_pass.
export function monitorTools(config: Config): Tool<HelixContext>[] {
  return monitorOf(config).passReads ? MONITOR_TOOLS : MONITOR_TOOLS.filter((t) => t.name !== 'note_pass');
}

async function applyAndRecord(root: string, r: { request: RequestKind; name: string; tasks: string[]; question: string; chose: string; why: string; confidence: number; changes: PlanChange[]; incident?: string; fixId?: string }): Promise<string> {
  const pilot = pilotOf(loadConfig(root));
  let applied;
  try {
    applied = await applyChanges(root, r.changes, { what: r.chose, by: 'Helix monitor', source: r.incident ? `incident ${r.incident}` : undefined });
  } catch (e) {
    if (e instanceof PlanEditError) throw new ToolError(e.message);
    throw e;
  }
  if (r.incident && r.fixId) appendStored(paths(root).incidents, { type: 'decided', key: r.incident, at: new Date().toISOString(), fix: r.fixId, decision: 'accepted', change: applied.change?.id });
  if (pilot.record || pilot.mode === 'active') {
    const n = readHitl(paths(root).hitl).records.length + 1;
    const action = r.changes.some((c) => c.op === 'park') ? 'park' : r.changes.some((c) => c.op === 'new_task') ? 'split' : r.changes.some((c) => c.op === 'hand_back') ? 'retry' : r.request === 'spec_plain' ? 'spec_answer' : r.changes.every((c) => c.op === 'note') ? 'note' : 'other';
    appendHitl(paths(root).hitl, {
      type: 'resolved', id: `H-${n}`, at: new Date().toISOString(), request: r.request, name: r.name, raisedBy: r.incident ? `incident ${r.incident}` : 'the loop', tasks: r.tasks, task: r.tasks[0],
      question: r.question, compared: pilot.active_level, mode: pilot.mode, level: pilot.mode === 'auto' ? pilot.auto_level : pilot.active_level,
      chose: r.chose, why: r.why, confidence: r.confidence, action, change: applied.change?.id,
    });
  }
  return `Applied${applied.created.length ? `; created ${applied.created.join(', ')}` : ''}${applied.change ? ` as ${applied.change.id}, which the owner can undo for a day` : ''}.`;
}

// The monitor's one-line reads of running passes: runs/helix-reads.jsonl, the latest per task wins.
export function appendReads(root: string, r: { task: string; text: string }): void {
  const f = join(paths(root).runs, 'helix-reads.jsonl');
  mkdirSync(paths(root).runs, { recursive: true });
  appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), ...r })}\n`);
}

export function readReads(root: string): Map<string, { at: string; text: string }> {
  const f = join(paths(root).runs, 'helix-reads.jsonl');
  const out = new Map<string, { at: string; text: string }>();
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, 'utf8').split('\n').slice(-500)) {
    try {
      const r = JSON.parse(l) as { at: string; task: string; text: string };
      out.set(r.task, { at: r.at, text: r.text });
    } catch {
      // a line mid-append
    }
  }
  return out;
}

// What the monitor starts each turn from: what happened since its last turn, not the raw logs.
export function digest(root: string, since: string | undefined, focus?: string): string {
  const p = paths(root);
  const events = readLedger(p.ledger);
  const plan = planOf(root);
  const config = loadConfig(root);
  const pilot = pilotOf(config);
  const after = (at: string) => !since || at > since;
  const passes = events.filter((e) => e.kind === 'pass' && after(e.at)) as Extract<ReturnType<typeof readLedger>[number], { kind: 'pass' }>[];
  const incs = incidentsOf(root).filter((i) => i.open);
  const reports = readReports(root).filter((r) => after(r.at));
  const live = loopStatus(root, events);
  const waiting = [...plan.tasks.values()].filter((t) => t.status === 'needs_human');
  const raised = readHitl(p.hitl).raised.filter((r) => !r.answered);
  const lines = [
    `Pilot mode: ${pilot.mode === 'auto' ? `Auto-pilot · ${pilot.auto_level}` : `Active pilot · ${pilot.active_level}`}. The loop is ${live.running ? 'running' : 'stopped'}.`,
    focus?.startsWith('human:')
      ? `${ownerOf(root)} just marked ${focus.slice(6)} done. Its notes say: ${planOf(root).human.get(focus.slice(6))?.notes ?? '(none)'}. With note_tasks, add what the tasks waiting on it need from it (an ID or a URL, never a secret's value) to their notes. Those tasks: ${[...planOf(root).tasks.values()].filter((t) => t.blocked_by.includes(focus.slice(6)) && t.status !== 'done').map((t) => t.id).join(', ') || 'none'}.`
      : focus ? `${ownerOf(root)} asked you to look again at incident ${focus} and revise its fix.` : '',
    `Since your last turn${since ? ` (${since})` : ''}: ${passes.length} passes ended, ${passes.filter((x) => x.outcome === 'merged').length} merged.`,
    ...passes.filter((x) => x.outcome !== 'merged').slice(-20).map((x) => `- ${x.task} attempt ${x.attempt} (${x.agent}): ${x.outcome}${x.failing ? `: ${x.failing}` : ''}`),
    reports.length ? 'Builder reports:' : '',
    ...reports.slice(-20).map((r) => `- ${r.task} (${r.agent}) ${r.kind === 'issue' ? `${r.issue}: ` : ''}${r.message.slice(0, 300)}`),
    'Open incidents (key · kind · tasks · failures · fix):',
    ...incs.slice(0, 25).map((i) => `- ${i.key} · ${i.kind} · ${i.members.length} tasks · ${i.failures} · ${i.fix ? `${i.fix.id}${i.decision ? ` ${i.decision.decision}` : ` waiting for ${ownerOf(root)}`}` : 'none'}${i.title ? ` · named "${i.title}"` : ''}`),
    waiting.length ? `Tasks that need a person: ${waiting.map((t) => t.id).join(', ')}` : '',
    raised.length ? `Your requests waiting for ${ownerOf(root)}: ${raised.map((r) => `${r.id} ${r.question}`).join('; ')}` : '',
    live.running ? `Running: ${[...plan.tasks.values()].filter((t) => t.status === 'claimed').map((t) => t.id).join(', ')}.${monitorOf(config).passReads ? ' Give each a one-line read with note_pass when you have one.' : ''}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

// What the Resolve button sends, as the owner's message in the thread.
export const RESOLVE_REQUEST = 'Please resolve this thread now, with your summary.';

export const HELIX_SERVER = { name: 'helix', instructions: "Helix Loop's plan tools, for Helix." };

// ---- running Helix ----

export interface HelixRunner {
  agent: (role: HelixRole) => AgentName | undefined; // the chosen and healthy agent for the role, if any
  // The real control plane's config: Helix runs the real CLI even on the dry run, whose config names the fakes.
  config: () => Config;
  port: () => number;
  onChange: () => void;
}

interface Queued {
  role: HelixRole;
  root: string;
  key?: string;
  focus?: string;
}

// One turn at a time, in the order asked; a thread or a monitor turn already waiting is not queued twice.
export class Helix {
  private queue: Queued[] = [];
  private busy: HelixJob | undefined;
  private runner: HelixRunner;
  lastMonitor: Record<string, string> = {}; // root → when its monitor last ran

  constructor(runner: HelixRunner) {
    this.runner = runner;
  }

  status(): { busy?: string; role?: HelixRole; queued: string[] } {
    return { busy: this.busy?.key ?? (this.busy ? 'monitor' : undefined), role: this.busy?.role, queued: this.queue.map((q) => q.key ?? 'monitor') };
  }

  jobFor(token: string): HelixJob | undefined {
    return this.busy && this.busy.tokenHash === hashToken(token) ? this.busy : undefined;
  }

  ask(root: string, key: string): void {
    if (this.busy?.key === key || this.queue.some((q) => q.key === key)) return;
    this.queue.push({ role: 'assistant', root, key });
    this.runner.onChange();
    void this.next();
  }

  watch(root: string, focus?: string): void {
    if (this.queue.some((q) => q.role === 'monitor' && q.root === root && q.focus === focus)) return;
    if (!focus && this.busy?.role === 'monitor' && this.busy.root === root) return;
    this.queue.push({ role: 'monitor', root, focus });
    this.runner.onChange();
    void this.next();
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    const token = newToken();
    const job: HelixJob = { role: item.role, key: item.key, focus: item.focus, root: item.root, tokenHash: hashToken(token), startedAt: new Date().toISOString(), resolved: false };
    this.busy = job;
    this.runner.onChange();
    try {
      await this.turn(job, token);
    } catch (e) {
      if (item.key) addMessage(paths(item.root).threads, item.key, 'helix', `I couldn't answer: ${(e as Error).message}`);
      else console.error(`helix monitor: ${(e as Error).message}`);
    } finally {
      if (item.role === 'monitor') this.lastMonitor[item.root] = job.startedAt;
      this.busy = undefined;
      this.runner.onChange();
      void this.next();
    }
  }

  private async turn(job: HelixJob, token: string): Promise<void> {
    const dir = paths(job.root).threads;
    const t = job.key ? thread(dir, job.key) : undefined;
    if (job.role === 'assistant' && (!t || t.waitingOn !== 'helix')) return;
    const agent = this.runner.agent(job.role);
    if (!agent) {
      if (job.key) addMessage(dir, job.key, 'helix', 'Helix isn\'t set up yet. Pick Claude Code or Codex in Settings › Helix, then reply here.');
      return;
    }
    const config = this.runner.config();
    const level = monitorOf(config).level;
    const { model, effort } = job.role === 'monitor' ? monitorModel(config, agent, level) : config.agents[agent].models.plan;
    const pilot = pilotOf(loadConfig(job.root === this.runner.config().root ? job.root : this.runner.config().root));
    const promptName = job.role === 'assistant' ? 'assistant' : monitorPromptName(pilot);
    const system = fillPrompt(this.runner.config().root, readPrompt(this.runner.config().root, promptName)?.text ?? '');
    // The monitor starts fresh each turn from a digest; the assistant resumes its thread's own session.
    const resume = job.role === 'assistant' && t!.agent === agent ? t!.session : undefined;
    const prompt = job.role === 'monitor' ? digest(job.root, this.lastMonitor[job.root], job.focus) : resume ? newMessages(t!, ownerOf(job.root)) : firstPrompt(t!, ownerOf(job.root));
    const url = `http://127.0.0.1:${this.runner.port()}/mcp/helix`;
    const cwd = join(tmpdir(), 'helix-loop-helix');
    mkdirSync(cwd, { recursive: true });
    const key = await readKey(agent);
    const env: NodeJS.ProcessEnv = { ...builderEnv(process.env), HELIX_MCP_TOKEN: token };
    // On its subscription when it has one; otherwise on the Helix key, in this process alone.
    const subscribed = (await health(config)).find((x) => x.agent === agent)?.subscription.light === 'green';
    if (!subscribed && key) env[KEY_ENV[agent]] = key;

    let args: string[];
    const session = resume ?? randomUUID();
    if (agent === 'claude') {
      const mcp = JSON.stringify({ mcpServers: { helix: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
      args = [
        '-p', '--output-format', 'json', '--model', model, '--effort', effort,
        '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--mcp-config', mcp,
        '--allowedTools', 'mcp__helix', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
        ...(resume ? ['--resume', resume] : ['--session-id', session]),
      ];
    } else {
      const common = [
        '--json', '--ignore-user-config', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-c', 'approval_policy="never"',
        '-c', `developer_instructions=${JSON.stringify(system)}`,
        // Every tool on Helix's endpoint is the app's own, checked by the app, so Codex approves them up front.
        '-c', `mcp_servers.helix.url=${JSON.stringify(url)}`, '-c', 'mcp_servers.helix.bearer_token_env_var="HELIX_MCP_TOKEN"', '-c', 'mcp_servers.helix.default_tools_approval_mode="approve"',
        '--skip-git-repo-check',
      ];
      args = resume ? ['exec', 'resume', resume, ...common, '-c', 'sandbox_mode="read-only"', '-'] : ['exec', ...common, '-s', 'read-only', '-C', cwd, '-'];
    }
    const res = await run(config.agents[agent].command, args, { cwd, env, stdin: prompt, timeoutMs: 15 * 60_000 });
    const out = agent === 'claude' ? claudeResult(res.stdout) : codexResult(res.stdout, config.limits.codex_price_per_mtok);
    const sessionId = agent === 'claude' ? (out.session ?? session) : out.session;
    if (job.key && sessionId) setSession(dir, job.key, agent, sessionId);
    // A turn that resolved the thread may say nothing more; the monitor speaks through its tools.
    if (!out.error && !out.text && !job.resolved && job.role === 'assistant') out.error = `no answer (exit ${res.code})`;
    const tail = out.error ? `${res.stdout.slice(-1500)}\n${res.stderr.slice(-500)}` : undefined;
    appendFileSync(paths(job.root).helixTurns, `${JSON.stringify({ at: new Date().toISOString(), role: job.role, thread: job.key, focus: job.focus, agent, model, effort, ...(job.role === 'monitor' ? { level } : {}), costUsd: out.costUsd, ok: !out.error, ...(tail ? { tail } : {}) })}\n`);
    if (out.error) throw new Error(`${agent} failed: ${out.error.slice(0, 300)}${res.stderr ? ` (${res.stderr.trim().slice(0, 200)})` : ''}`);
    if (job.key && !job.resolved && out.text) addMessage(dir, job.key, 'helix', out.text);
  }
}

// What the monitor spent today, for its own cap (helix.monitor.daily_budget_usd).
export function monitorSpentToday(file: string, day: string, localDay: (ms: number) => string): number {
  if (!existsSync(file)) return 0;
  let usd = 0;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const r = JSON.parse(l) as { at: string; role?: string; costUsd?: number };
      if (r.role === 'monitor' && localDay(Date.parse(r.at)) === day) usd += r.costUsd ?? 0;
    } catch {
      // a line mid-append
    }
  }
  return usd;
}

function firstPrompt(t: Thread, owner: string): string {
  return [
    `Thread ${t.key}, about ${targetLabel(t.target)}.`,
    `${owner} commented:`,
    '',
    t.root.text,
    ...t.messages.slice(1).filter((m) => m.kind === 'message').map((m) => `\n${m.author === 'owner' ? owner : 'You'}: ${m.text}`),
  ].join('\n');
}

function newMessages(t: Thread, owner: string): string {
  const lastMine = t.messages.findLastIndex((m) => m.author === 'helix' && m.kind === 'message');
  const since = t.messages.slice(lastMine + 1);
  return since
    .map((m) =>
      m.kind === 'decision'
        ? `${owner} ${m.decision} proposal ${m.proposal}.${m.text ? ` ${m.text}` : ''}`
        : m.kind === 'message' && m.author === 'owner'
          ? `${owner}: ${m.text}`
          : '',
    )
    .filter(Boolean)
    .join('\n\n') || `${owner} reopened the thread.`;
}

interface TurnResult {
  text: string;
  session?: string;
  costUsd: number;
  error?: string;
}

function claudeResult(stdout: string): TurnResult {
  try {
    const r = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean };
    return { text: String(r.result ?? '').trim(), session: r.session_id, costUsd: Number(r.total_cost_usd ?? 0), error: r.is_error ? String(r.result ?? 'error') : undefined };
  } catch {
    return { text: '', costUsd: 0, error: stdout.slice(0, 300) || 'no answer' };
  }
}

// Codex reports tokens, not cost: priced as the codex adapter prices a pass (USD per million tokens).
function codexResult(stdout: string, price: { input: number; cached_input: number; output: number }): TurnResult {
  let text = '';
  let session: string | undefined;
  const errors: string[] = [];
  let costUsd = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string }; message?: string; error?: { message?: string }; usage?: Record<string, number> };
      if (ev.type === 'turn.completed' && ev.usage) {
        const u = ev.usage;
        const cached = u.cached_input_tokens ?? 0;
        costUsd += (((u.input_tokens ?? 0) - cached) * price.input + cached * price.cached_input + ((u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0)) * price.output) / 1e6;
      }
      if (ev.type === 'thread.started') session = ev.thread_id;
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = String(ev.item.text ?? '');
      if (ev.type === 'error') errors.push(String(ev.message ?? ''));
      if (ev.type === 'turn.failed') errors.push(String(ev.error?.message ?? 'turn failed'));
    } catch {
      // a partial line
    }
  }
  return { text: text.trim(), session, costUsd, error: errors.length && !text ? errors.join('; ') : undefined };
}
