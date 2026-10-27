import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config.ts';
import { hashToken, readLive, type LivePass } from '../live.ts';
import type { Report } from './state.ts';

// The app's MCP endpoints (spec §9): Streamable HTTP, stateless, plain JSON responses. Three methods are all a
// client needs from a server that only offers tools, so the protocol is written out here rather than taken
// from the SDK, which would bring a web framework with it.

export interface Tool<C> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, ctx: C) => Promise<string> | string;
}

// A tool's refusal: the model sees the message and can act on it; the JSON-RPC call itself succeeds.
export class ToolError extends Error {}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
export type RpcReply = { status: number; body?: unknown };

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export async function handleRpc<C>(raw: unknown, tools: Tool<C>[], ctx: C, server: { name: string; instructions: string }): Promise<RpcReply> {
  if (Array.isArray(raw) || !raw || typeof raw !== 'object') return { status: 400, body: rpcError(null, -32600, 'one JSON-RPC request per POST') };
  const msg = raw as Rpc;
  // Notifications and responses get no answer but "accepted".
  if (msg.id === undefined || !msg.method) return { status: 202 };
  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id: msg.id, result } });
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: '1.0.0' },
        instructions: server.instructions,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return { status: 200, body: rpcError(msg.id, -32602, `unknown tool ${String(msg.params?.name)}`) };
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok({ content: [{ type: 'text', text: await tool.call(args, ctx) }] });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(`mcp ${tool.name}: ${(e as Error).stack ?? e}`);
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return { status: 200, body: rpcError(msg.id, -32601, `method not found: ${msg.method}`) };
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Arguments, checked by hand against the few shapes the tools take.
export function str(args: Record<string, unknown>, key: string, max: number, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new ToolError(`${key} is at most ${max} characters; this is ${t.length}`);
  return t;
}

// ---- the builders' endpoint ----

export interface BuilderContext {
  root: string;
  pass: LivePass;
}

// The pass a bearer token belongs to: only a pass in flight, in any root the app serves (the real control
// plane and the dry run), has one.
export function passFor(roots: string[], token: string): BuilderContext | undefined {
  const h = hashToken(token);
  for (const root of roots) {
    const pass = readLive(paths(root).live)?.passes.find((x) => x.tokenHash === h);
    if (pass) return { root, pass };
  }
  return undefined;
}

// The kinds a builder reports (spec §10); gate failures are the loop's to record, not a builder's.
export const ISSUE_KINDS = ['spec_question', 'flaky_test', 'blocked_on_human', 'credential_missing', 'scope_grew', 'conflict', 'environment'] as const;

function file(ctx: BuilderContext, r: Omit<Report, 'at' | 'pass' | 'task' | 'agent' | 'attempt'>): Report {
  const report: Report = { at: new Date().toISOString(), pass: ctx.pass.id, task: ctx.pass.task, agent: ctx.pass.agent, attempt: ctx.pass.attempt, ...r };
  const f = paths(ctx.root).reports;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify(report)}\n`);
  return report;
}

export const BUILDER_TOOLS: Tool<BuilderContext>[] = [
  {
    name: 'report_progress',
    description: 'Tell Daniel, in a few words, what you are doing now on this task, as you start each main step. It shows on the task\'s bar in the dependency map. It changes nothing in the loop.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', maxLength: 144, description: 'What you are doing now, at most 144 characters.' } },
      required: ['message'],
      additionalProperties: false,
    },
    call: (args, ctx) => {
      file(ctx, { kind: 'progress', message: str(args, 'message', 144)! });
      return 'Shown on the map.';
    },
  },
  {
    name: 'report_issue',
    description:
      'Report something outside your task that is in your way, the moment you find it: the spec is ambiguous or silent on something the task needs (spec_question); a test unrelated to your change fails intermittently (flaky_test); the task needs something a human task provides (blocked_on_human); a secret, environment variable or access is missing (credential_missing: name the variable, never a value); the task is bigger than planned or the plan misses a dependency (scope_grew); merge conflicts, or main changed under you (conflict); or the sandbox, network or tooling fails you (environment). It goes to Daniel or to Helix, and into this attempt\'s notes. Keep working unless you cannot go on; set blocking when you cannot.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...ISSUE_KINDS] },
        message: { type: 'string', maxLength: 2000, description: 'What is wrong and what you need, specifically.' },
        paths: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Files or spec sections it concerns, if any.' },
        blocking: { type: 'boolean', description: 'True when you cannot go on with the task without it.' },
      },
      required: ['kind', 'message'],
      additionalProperties: false,
    },
    call: (args, ctx) => {
      const kind = str(args, 'kind', 40)!;
      if (!(ISSUE_KINDS as readonly string[]).includes(kind)) throw new ToolError(`kind is one of ${ISSUE_KINDS.join(', ')}`);
      const p = Array.isArray(args.paths) ? args.paths.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 300)) : undefined;
      file(ctx, { kind: 'issue', issue: kind, message: str(args, 'message', 2000)!, ...(p?.length ? { paths: p } : {}), ...(args.blocking === true ? { blocking: true } : {}) });
      return 'Reported to Daniel. Keep going with the task.';
    },
  },
];

export const BUILDER_SERVER = {
  name: 'helix',
  instructions: 'Helix Loop. Report progress and problems on the task you are building; the loop decides everything else.',
};
