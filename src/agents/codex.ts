import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, Config, Role } from '../config.ts';
import { clipText, outputTail, summarise, type Activity, type Adapter, type AgentResult, type FeedStep, type Invocation, type Usage, type UsageWindow } from './adapter.ts';
import { parseResetTime } from './resets.ts';

// Codex adapter: `codex exec --json` in the workspace-write sandbox with network on, approvals
// off, and the user's desktop config ignored. Features that keep processes alive past a turn
// (unified exec terminals) or reach outside the repo (computer use, browser, apps) are disabled.
// Sessions are persisted because the rollout file is where Codex records `rate_limits.resets_at`;
// CODEX_HOME is passed explicitly so the CLI writes it where the adapter reads it.

const DISABLED_FEATURES = ['unified_exec', 'computer_use', 'browser_use', 'in_app_browser', 'apps', 'plugins', 'multi_agent'];

export function codexAdapter(agent: AgentConfig, config: Config, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): Adapter {
  const price = config.limits.codex_price_per_mtok;
  const base = (role: Role, effort = agent.models[role].effort) => [
    'exec', '--json', '--ignore-user-config',
    '-m', agent.models[role].model,
    '-c', `model_reasoning_effort="${effort}"`,
    '-c', 'approval_policy="never"',
    '-s', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  ];
  return {
    name: 'codex',
    invocation(role, cwd, prompt, mcp): Invocation {
      // The loop app's MCP server, the only one: --ignore-user-config keeps out the person's own. The token
      // goes in the environment, where Codex reads it as the server's bearer token. Its two tools only report, so
      // they are approved up front; with approvals off, Codex would otherwise refuse every call.
      const server = mcp
        ? ['-c', `mcp_servers.helix.url=${JSON.stringify(mcp.url)}`, '-c', 'mcp_servers.helix.bearer_token_env_var="HELIX_MCP_TOKEN"', '-c', 'mcp_servers.helix.default_tools_approval_mode="approve"']
        : [];
      const env = { CODEX_HOME: codexHome, ...(mcp ? { HELIX_MCP_TOKEN: mcp.token } : {}) };
      return { cmd: agent.command, args: [...base(role), ...server, '-C', cwd, '-'], stdin: prompt, env };
    },
    probe(cwd): Invocation {
      return {
        cmd: agent.command,
        args: [...base('build', 'low'), '--skip-git-repo-check', '-C', cwd, '-'],
        stdin: 'Reply with the single word OK.',
        env: { CODEX_HOME: codexHome },
      };
    },
    // A tool call is a completed command, file change, MCP call or web search; commands carry their command line.
    observe(line): Activity {
      const out: Activity = { toolCalls: 0, commands: [] };
      if (!line.startsWith('{"type":"item.completed"')) return out;
      try {
        const item = (JSON.parse(line) as { item?: { type?: string; command?: unknown } }).item;
        if (!item || !['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type ?? '')) return out;
        out.toolCalls++;
        if (item.type === 'command_execution' && typeof item.command === 'string') out.commands.push(item.command);
      } catch {
        // a partial line at a kill
      }
      return out;
    },
    interpret(stdout, stderr, exitCode, now): AgentResult {
      let threadId: string | undefined;
      let last = '';
      let errors: string[] = [];
      const tokens = { input: 0, cachedInput: 0, output: 0 };
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'thread.started') threadId = ev.thread_id;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = String(ev.item.text ?? '');
        if (ev.type === 'turn.completed' && ev.usage) {
          tokens.cachedInput += ev.usage.cached_input_tokens ?? 0;
          tokens.input += (ev.usage.input_tokens ?? 0) - (ev.usage.cached_input_tokens ?? 0);
          tokens.output += (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
        }
        if (ev.type === 'error') errors.push(String(ev.message ?? ''));
        if (ev.type === 'turn.failed') errors.push(String(ev.error?.message ?? 'turn failed'));
      }
      const costUsd = (tokens.input * price.input + tokens.cachedInput * price.cached_input + tokens.output * price.output) / 1e6;
      const errText = `${errors.join('\n')}\n${stderr}`;
      const limits = lastRateLimits(codexHome, threadId, now);
      const base = { costUsd, tokens, summary: summarise(last), resetAt: null, usage: limits ? usageFromRateLimits(limits, now) : undefined };

      if (/usage limit|hit your limit|rate limit reached|quota/i.test(errText)) {
        const resetAt = (limits ? resetFromRateLimits(limits) : null) ?? parseResetTime(errText, now);
        return { ...base, kind: 'limited', resetAt, detail: summarise(errText, 300) };
      }
      // "Selected model is at capacity. Please try a different model.": OpenAI's overloaded, not the task's fault.
      if (/\b5\d\d\b|overloaded|at capacity|stream disconnected|ECONNRESET|ETIMEDOUT|network error/i.test(errText) && errors.length) {
        return { ...base, kind: 'transient', detail: summarise(errText, 300) };
      }
      if (errors.length || exitCode !== 0) return { ...base, kind: 'error', detail: summarise(errText || `exit ${exitCode}`, 600) };
      return { ...base, kind: 'ok' };
    },
  };
}

// One line of `codex exec --json`, for the loop app's activity feed: an item when it starts and again, settled,
// when it completes; its own words; and the end of its turn.
export function describeCodex(line: string): FeedStep[] | undefined {
  if (!line.startsWith('{')) return undefined;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof ev?.type !== 'string') return undefined; // a test's own JSON logging, in the gate's output
  if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
    const step = codexItem(ev.item ?? {});
    if (!step) return [];
    const call = step.kind === 'command' || step.kind === 'edit' || step.kind === 'tool';
    return [{ ...step, ref: String(ev.item?.id ?? ''), state: step.state ?? (call ? (ev.type === 'item.completed' ? 'ok' : 'running') : undefined) }];
  }
  if (ev.type === 'turn.completed') return [{ kind: 'done', text: 'Finished its turn' }];
  if (ev.type === 'turn.failed') return [{ kind: 'error', text: clipText(String(ev.error?.message ?? 'the turn failed'), 600) }];
  if (ev.type === 'error') return [{ kind: 'error', text: clipText(String(ev.message ?? 'error'), 600) }];
  return ev.type === 'thread.started' || ev.type === 'turn.started' ? [] : undefined;
}

// `/bin/zsh -lc 'pnpm lint'` is the command `pnpm lint`, as the agent wrote it.
export function unwrapShell(command: string): string {
  const single = /^\S*\b(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  if (single) return single[1]!.replace(/'\\''/g, "'");
  const double = /^\S*\b(?:ba|z)?sh -l?c "([\s\S]*)"$/.exec(command);
  return double ? double[1]!.replace(/\\(["\\$`])/g, '$1') : command;
}

function codexItem(item: Record<string, any>): FeedStep | undefined {
  switch (item.type) {
    case 'agent_message':
      return String(item.text ?? '').trim() ? { kind: 'message', text: clipText(String(item.text).trim(), 2000) } : undefined;
    case 'reasoning':
      return String(item.text ?? '').trim() ? { kind: 'thinking', text: clipText(String(item.text).trim(), 600) } : undefined;
    case 'command_execution': {
      const out = String(item.aggregated_output ?? '');
      const failed = typeof item.exit_code === 'number' && item.exit_code !== 0;
      return {
        kind: 'command',
        text: unwrapShell(String(item.command ?? '')),
        detail: out.trim() ? outputTail(out) : undefined,
        state: failed || item.status === 'failed' ? 'failed' : undefined,
      };
    }
    case 'file_change': {
      const changes = (item.changes ?? []) as { path?: string; kind?: string }[];
      const paths = changes.map((c) => String(c.path ?? ''));
      return { kind: 'edit', text: changes.length === 1 ? `${changes[0]!.kind === 'add' ? 'Wrote' : changes[0]!.kind === 'delete' ? 'Deleted' : 'Edited'} ${paths[0]}` : `Edited ${changes.length} files`, detail: changes.length > 1 ? changes.map((c) => `${c.kind ?? 'update'} ${c.path}`).join('\n') : undefined, paths };
    }
    case 'mcp_tool_call': {
      const args = (typeof item.arguments === 'string' ? safeJson(item.arguments) : item.arguments) ?? {};
      // Logs from before Helix Loop was named call the server mushy.
      if ((item.server === 'helix' || item.server === 'mushy') && item.tool === 'report_progress') return { kind: 'report', text: String(args.message ?? 'progress reported') };
      if ((item.server === 'helix' || item.server === 'mushy') && item.tool === 'report_issue') return { kind: 'issue', text: `${String(args.kind ?? 'issue').replace(/_/g, ' ')}: ${args.message ?? ''}` };
      return { kind: 'tool', text: `Called ${item.server}.${item.tool}`, state: item.status === 'failed' ? 'failed' : undefined };
    }
    case 'web_search':
      return { kind: 'tool', text: `Searched the web for ${item.query ?? ''}` };
    case 'todo_list': {
      const items = (item.items ?? []) as { text?: string; completed?: boolean }[];
      const done = items.filter((t) => t.completed).length;
      const now = items.find((t) => !t.completed)?.text;
      return { kind: 'plan', text: `${done} of ${items.length} done${now ? `; next: ${now}` : ''}`, detail: items.map((t) => `${t.completed ? '✓' : '○'} ${t.text ?? ''}`).join('\n') };
    }
    case 'error':
      return { kind: 'error', text: clipText(String(item.message ?? 'error'), 600) };
    default:
      return undefined;
  }
}

function safeJson(s: string): Record<string, any> | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// The last line of this thread's rollout file that records the rate limits, if it has one.
function lastRateLimits(codexHome: string, threadId: string | undefined, now: number): string | undefined {
  if (!threadId) return undefined;
  const sessions = join(codexHome, 'sessions');
  for (let back = 0; back <= 1; back++) {
    const d = new Date(now - back * 86_400_000);
    const dir = join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => f.includes(threadId));
    if (!file) continue;
    return readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.includes('"rate_limits"')).at(-1);
  }
  return undefined;
}

type RateWindow = { used_percent: number; window_minutes?: number; resets_at: number };

function rateLimitsIn(line: string): { primary?: RateWindow; secondary?: RateWindow; rate_limit_reached_type?: unknown } | undefined {
  const find = (o: any): any => {
    if (!o || typeof o !== 'object') return undefined;
    if (o.rate_limits) return o.rate_limits;
    for (const v of Object.values(o)) {
      const r = find(v);
      if (r) return r;
    }
    return undefined;
  };
  try {
    return find(JSON.parse(line));
  } catch {
    return undefined;
  }
}

// The reset time of whichever window is exhausted.
export function resetFromRateLimits(line: string): number | null {
  const limits = rateLimitsIn(line);
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].filter(Boolean) as RateWindow[];
  const exhausted = windows.filter((w) => w.used_percent >= 100);
  const pickFrom = exhausted.length ? exhausted : limits.rate_limit_reached_type ? windows : [];
  if (!pickFrom.length) return null;
  // Work resumes only when every exhausted window has reset.
  return Math.max(...pickFrom.map((w) => w.resets_at * 1000));
}

// The subscription's windows from a rate_limits line, told apart by their length: a window of a day or less
// is the session window, one of six days or more the weekly one. Codex states the share used as a percentage.
export function usageFromRateLimits(line: string, now: number): Usage | undefined {
  const limits = rateLimitsIn(line);
  const usage: Usage = { at: now };
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w || typeof w.used_percent !== 'number' || typeof w.resets_at !== 'number' || typeof w.window_minutes !== 'number') continue;
    const window: UsageWindow = { used: w.used_percent / 100, resetsAt: w.resets_at * 1000 };
    if (w.window_minutes <= 24 * 60) usage.session = window;
    else if (w.window_minutes >= 6 * 24 * 60) usage.weekly = window;
  }
  return usage.session || usage.weekly ? usage : undefined;
}
