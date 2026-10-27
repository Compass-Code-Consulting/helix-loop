import { join } from 'node:path';
import type { AgentConfig, Config, Role } from '../config.ts';
import { paths } from '../config.ts';
import { BUILDER_TOOLS, clipText, outputTail, summarise, type Activity, type Adapter, type AgentResult, type FeedStep, type Invocation, type Usage, type UsageWindow } from './adapter.ts';
import { parseResetTime } from './resets.ts';

// Claude Code adapter: `claude -p` with a tool allowlist, nothing that prompts (anything not allowed
// is denied), Bash in Claude Code's sandbox, and a PreToolUse hook that refuses background commands
// (L7) and file writes outside the worktree. Every outward-facing CLI is denied.

const ALLOWED = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  ...[
    'npm', 'npx', 'pnpm', 'node', 'tsc', 'git', 'ls', 'mkdir', 'mv', 'cp', 'rm', 'touch', 'chmod', 'cat', 'echo',
    'printf', 'pwd', 'test', 'grep', 'rg', 'find', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
    'diff', 'xargs', 'jq', 'curl', 'lsof', 'kill', 'psql', 'createdb', 'dropdb', 'pg_isready', 'docker',
  ].map((c) => `Bash(${c}:*)`),
  // The gate's all-on integration run (scripts/gate/76-integration-all-on.ts). A rule matches a command's first
  // word, so without this one the variable in front is denied and Claude can't reproduce that run (T-0063).
  'Bash(MUSHY_FLAGS=all-on pnpm:*)',
];

const DENIED = [
  'Bash(git push:*)', 'Bash(git checkout main:*)', 'Bash(git switch main:*)', 'Bash(git update-ref:*)',
  ...['gh', 'doctl', 'ssh', 'scp', 'sudo', 'tofu', 'kubectl', 'helm', 'aws', 'stripe', 'wrangler', 'sentry-cli', 'claude', 'codex'].map(
    (c) => `Bash(${c}:*)`,
  ),
];

export function claudeAdapter(agent: AgentConfig, config: Config): Adapter {
  const hook = join(paths(config.root).hooks, 'claude-pretooluse.ts');
  const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node ${quoted(hook)}` }] }],
    },
    // Bash runs in Claude Code's OS sandbox: writes confined to the working directory (plus the pnpm store
    // and the Playwright cache), network only to the allowlist and localhost. failIfUnavailable: without it,
    // Claude Code would run commands unsandboxed when the sandbox cannot start.
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: config.agent_network?.allow_write ?? [] },
      network: { allowedDomains: config.agent_network?.allowed_domains ?? [], strictAllowlist: true, allowLocalBinding: true },
    },
  });
  const base = (role: Role, effort = agent.models[role].effort) => [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', agent.models[role].model, '--effort', effort,
    '--no-session-persistence', '--settings', settings,
    // No MCP server in a pass but the loop app's: the person's own connectors (mail, drive, ...) never reach a builder.
    '--strict-mcp-config',
  ];
  return {
    name: 'claude',
    invocation(role, _cwd, prompt, mcp): Invocation {
      const server = mcp
        ? ['--mcp-config', JSON.stringify({ mcpServers: { helix: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } })]
        : [];
      const tools = mcp ? BUILDER_TOOLS.map((t) => `mcp__helix__${t}`) : [];
      return {
        cmd: agent.command,
        args: [
          ...base(role),
          ...server,
          '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
          '--allowedTools', ...ALLOWED, ...tools, '--disallowedTools', ...DENIED,
        ],
        stdin: prompt,
      };
    },
    probe(): Invocation {
      return { cmd: agent.command, args: [...base('build', 'low'), '--tools', ''], stdin: 'Reply with the single word OK.' };
    },
    // A tool call is a tool_use block in an assistant message; Bash's carry the command.
    observe(line): Activity {
      const out: Activity = { toolCalls: 0, commands: [] };
      if (!line.startsWith('{"type":"assistant"')) return out;
      try {
        const ev = JSON.parse(line) as { message?: { content?: { type?: string; name?: string; input?: { command?: unknown } }[] } };
        for (const c of ev.message?.content ?? []) {
          if (c.type !== 'tool_use') continue;
          out.toolCalls++;
          if (c.name === 'Bash' && typeof c.input?.command === 'string') out.commands.push(c.input.command);
        }
      } catch {
        // a partial line at a kill
      }
      return out;
    },
    interpret(stdout, stderr, exitCode, now): AgentResult {
      let result: Record<string, unknown> | undefined;
      let windows: Usage | undefined;
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === 'result') result = ev;
          if (ev.type === 'rate_limit_event') windows = claudeUsage(ev, now) ?? windows;
        } catch {
          // a partial line at a kill; ignore
        }
      }
      const usage = (result?.usage ?? {}) as Record<string, number>;
      const tokens = {
        input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        cachedInput: usage.cache_read_input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      };
      const costUsd = Number(result?.total_cost_usd ?? 0);
      const text = String(result?.result ?? '');
      const errText = `${result?.is_error ? text : ''}\n${stderr}`;
      const base = { costUsd, tokens, summary: summarise(text), resetAt: null, usage: windows };

      if (/hit your (session|weekly|usage)? ?limit|usage limit reached|limit reached/i.test(errText) || result?.api_error_status === 429) {
        return { ...base, kind: 'limited', resetAt: parseResetTime(errText, now), detail: summarise(errText, 300) };
      }
      if (/went to sleep/i.test(errText)) return { ...base, kind: 'suspended', detail: summarise(errText, 300) };
      const status = Number(result?.api_error_status ?? 0);
      if (status >= 500 || /overloaded|ECONNRESET|ETIMEDOUT|socket hang up|network error/i.test(errText)) {
        return { ...base, kind: 'transient', detail: summarise(errText, 300) };
      }
      if (!result || result.is_error || exitCode !== 0) {
        return { ...base, kind: 'error', detail: summarise(errText || `exit ${exitCode}`, 600) };
      }
      return { ...base, kind: 'ok' };
    },
  };
}

// One line of Claude Code's stream-json, for the loop app's activity feed: its tool calls (settled by their
// results), its own words, and the end of its turn. Its thinking reaches the stream redacted, so it is left out.
export function describeClaude(line: string): FeedStep[] | undefined {
  if (!line.startsWith('{')) return undefined;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof ev?.type !== 'string') return undefined; // a test's own JSON logging, in the gate's output
  const out: FeedStep[] = [];
  if (ev.type === 'assistant') {
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'text' && String(c.text ?? '').trim()) out.push({ kind: 'message', text: clipText(String(c.text).trim(), 2000) });
      if (c.type === 'thinking' && String(c.thinking ?? '').trim()) out.push({ kind: 'thinking', text: clipText(String(c.thinking).trim(), 600) });
      if (c.type === 'tool_use') out.push({ ...claudeTool(String(c.name ?? ''), c.input ?? {}), ref: String(c.id ?? ''), state: 'running' });
    }
  } else if (ev.type === 'user') {
    for (const c of ev.message?.content ?? []) {
      if (c.type !== 'tool_result' || !c.tool_use_id) continue;
      const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? '').join('\n') : '';
      out.push({ ref: String(c.tool_use_id), state: c.is_error ? 'failed' : 'ok', detail: text.trim() ? outputTail(text) : undefined });
    }
  } else if (ev.type === 'system' && ev.subtype === 'permission_denied' && ev.tool_use_id) {
    out.push({ ref: String(ev.tool_use_id), state: 'failed', detail: `Denied: ${ev.decision_reason ?? 'needs approval'}` });
  } else if (ev.type === 'result') {
    const text = String(ev.result ?? '').trim();
    out.push({ kind: ev.is_error ? 'error' : 'done', text: ev.is_error ? clipText(text || 'the turn ended in an error', 600) : 'Finished its turn', detail: ev.is_error ? undefined : clipText(text, 2000) });
  } else return ev.type === 'system' || ev.type === 'rate_limit_event' || ev.type === 'tool_progress' || ev.type === 'stream_event' ? [] : undefined;
  return out;
}

function claudeTool(name: string, input: Record<string, any>): FeedStep {
  const path = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
  // Logs from before Helix Loop was named call the server mushy.
  const mushy = /^mcp__(?:helix|mushy)__(.+)$/.exec(name)?.[1];
  if (mushy === 'report_progress') return { kind: 'report', text: String(input.message ?? '') };
  if (mushy === 'report_issue') return { kind: 'issue', text: `${String(input.kind ?? 'issue').replace(/_/g, ' ')}: ${input.message ?? ''}` };
  switch (name) {
    case 'Bash':
      return { kind: 'command', text: String(input.command ?? ''), note: input.description ? String(input.description) : undefined };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', text: `Edited ${path}`, paths: [path] };
    case 'Write':
      return { kind: 'edit', text: `Wrote ${path}`, paths: [path] };
    case 'Read':
      return { kind: 'read', text: path, paths: [path] };
    case 'Grep':
      return { kind: 'search', text: `${input.pattern ?? ''}${path ? ` in ${path}` : ''}${input.glob ? ` (${input.glob})` : ''}` };
    case 'Glob':
      return { kind: 'search', text: `${input.pattern ?? ''}${path ? ` in ${path}` : ''}` };
    case 'TodoWrite': {
      const todos = (input.todos ?? []) as { content?: string; status?: string }[];
      const done = todos.filter((t) => t.status === 'completed').length;
      const now = todos.find((t) => t.status === 'in_progress')?.content;
      return { kind: 'plan', text: `${done} of ${todos.length} done${now ? `; now: ${now}` : ''}`, detail: todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content ?? ''}`).join('\n') };
    }
    case 'WebFetch':
      return { kind: 'tool', text: `Fetched ${input.url ?? ''}` };
    case 'WebSearch':
      return { kind: 'tool', text: `Searched the web for ${input.query ?? ''}` };
    case 'Task':
    case 'Agent':
      return { kind: 'tool', text: `Started a subagent: ${input.description ?? ''}` };
    default:
      return { kind: 'tool', text: `Used ${name}` };
  }
}

// Claude Code reports the subscription's windows in its rate_limit_event lines, as the share used and the
// reset in epoch seconds: rate_limit_info.unifiedWindows.five_hour and .seven_day.
export function claudeUsage(ev: Record<string, unknown>, now: number): Usage | undefined {
  const windows = (ev.rate_limit_info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> } | undefined)?.unifiedWindows;
  const window = (w?: { utilization?: unknown; resetsAt?: unknown }): UsageWindow | undefined =>
    typeof w?.utilization === 'number' && typeof w.resetsAt === 'number' ? { used: w.utilization, resetsAt: w.resetsAt * 1000 } : undefined;
  const session = window(windows?.five_hour);
  const weekly = window(windows?.seven_day);
  return session || weekly ? { at: now, session, weekly } : undefined;
}
