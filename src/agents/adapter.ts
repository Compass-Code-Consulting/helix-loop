import type { AgentConfig, Config, Role } from '../config.ts';
import type { AgentName } from '../types.ts';

// What every agent CLI adapter provides. The loop never branches on which CLI it is talking to;
// everything that differs between Claude Code and Codex lives behind this interface.

export interface Invocation {
  cmd: string;
  args: string[];
  stdin: string;
  env?: NodeJS.ProcessEnv;
}

export type RunKind =
  | 'ok' // the CLI finished its turn; whether it did the task is for the gate to say
  | 'limited' // session limit (quota wall)
  | 'suspended' // the host slept mid-response
  | 'transient' // overloaded, 5xx, network: retry later, not the task's fault
  | 'error'; // anything else

export interface AgentResult {
  kind: RunKind;
  resetAt: number | null; // when limited
  costUsd: number; // notional, at list price
  tokens: { input: number; cachedInput: number; output: number };
  summary: string; // the agent's final message, trimmed
  detail?: string; // error text
  usage?: Usage; // the subscription's windows as the run left them, when the CLI reports them
}

// A subscription window: the share of it used (0 to 1) and when it resets (epoch ms).
export interface UsageWindow {
  used: number;
  resetsAt: number;
}

// An agent's subscription windows as its CLI last reported them: the short session window and the weekly
// one. The loop paces each agent by the weekly window (quota.ts paceSlots).
export interface Usage {
  at: number; // when it was read
  session?: UsageWindow;
  weekly?: UsageWindow;
}

// What one line of an agent's output shows it doing: the tool calls it made, and the shell commands among them.
export interface Activity {
  toolCalls: number;
  commands: string[];
}

// What one line of an agent's output shows it doing, for the loop app's activity feed (app/feed.ts). A step
// with a `ref` is the CLI's own id for a call: a later step with the same ref settles it (its result, its exit),
// in place. Each CLI's describe function (claude.ts, codex.ts) returns undefined for a line that isn't one of
// its events, which the feed then shows as plain output.
export type FeedKind = 'message' | 'thinking' | 'command' | 'edit' | 'read' | 'search' | 'plan' | 'report' | 'issue' | 'tool' | 'done' | 'error';
export interface FeedStep {
  kind?: FeedKind; // absent on a step that only settles an earlier one
  ref?: string;
  text?: string;
  detail?: string; // a command's output, an edit's files, a plan's items: shown when opened
  note?: string; // what the builder said a command is for
  state?: 'running' | 'ok' | 'failed';
  paths?: string[]; // files it read or changed
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
// The last lines of a command's output, which say how it ended.
export const outputTail = (s: string, lines = 12, max = 1500) => clip(s.trimEnd().split('\n').slice(-lines).join('\n'), max);
export const clipText = clip;

// pnpm's own commands, which are not the repo's scripts; and its flags that take a value.
const PNPM_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'dlx', 'why', 'list', 'ls', 'outdated', 'store', 'config', 'env', 'create', 'init', 'link', 'unlink', 'rebuild', 'prune', 'audit', 'licenses', 'patch', 'deploy', 'fetch', 'import', 'pack', 'publish', 'root', 'bin', 'setup', 'help', 'view', 'info', 'search', 'outdated']);
const PNPM_VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--reporter']);

// The package scripts and tools the agent ran, by name, with how many times: "pnpm test:integration" and
// "pnpm run --silent e2e -- x" count a script; "pnpm exec vitest run x" and "pnpm vitest x" count the tool.
export function scriptsIn(commands: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const command of commands) {
    for (const part of command.split(/&&|\|\||[;|\n]/)) {
      const words = part.replace(/["'`]/g, ' ').trim().split(/\s+/);
      let i = words.indexOf('pnpm') + 1;
      if (i === 0) continue;
      const skipFlags = () => {
        while (i < words.length && words[i]!.startsWith('-')) i += PNPM_VALUE_FLAGS.has(words[i]!) ? 2 : 1;
      };
      skipFlags();
      if (words[i] === 'run' || words[i] === 'exec') {
        i++;
        skipFlags();
      }
      const name = words[i]?.replace(/:+$/, '');
      if (!name || PNPM_COMMANDS.has(name) || !/^[a-z][\w:.-]*$/.test(name)) continue;
      out[name] = (out[name] ?? 0) + 1;
    }
  }
  return out;
}

// The loop app's MCP endpoint for one pass (app/mcp.ts): the builder reports its progress and problems there.
// The token binds every call to this pass and stops working when the pass ends.
export interface PassMcp {
  url: string;
  token: string;
}

// The tools a builder may call on it, as named in the app.
export const BUILDER_TOOLS = ['report_progress', 'report_issue'] as const;

export interface Adapter {
  readonly name: AgentName;
  invocation(role: Role, cwd: string, prompt: string, mcp?: PassMcp): Invocation;
  // Called with each line of stdout as it arrives, for the pass's metrics.
  observe(line: string): Activity;
  // Called with the full stdout once the process has exited.
  interpret(stdout: string, stderr: string, exitCode: number | null, now: number): Promise<AgentResult> | AgentResult;
  // The cheapest request that tells whether the session limit has lifted.
  probe(cwd: string): Invocation;
}

export type AdapterFactory = (name: AgentName, agent: AgentConfig, config: Config) => Adapter;

// What a builder must never inherit from whoever started the loop. A parent Claude Code or Codex session
// passes on its own identity and settings (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, CODEX_SANDBOX,
// AI_AGENT, MCP_*), and its editor host a way into the editor (VSCODE_*, ELECTRON_RUN_AS_NODE); an
// API key or endpoint in the shell (ANTHROPIC_*, OPENAI_*) would move a builder off its subscription.
// The adapter's own settings (CODEX_HOME) and the loop's (MUSHY_*) are added afterwards, on purpose.
const INHERITED = /^(CLAUDE|CODEX|ANTHROPIC_|OPENAI_|MCP_|VSCODE_|AI_AGENT$|ELECTRON_RUN_AS_NODE$)/;

export function builderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)));
}

export function summarise(text: string, max = 2000): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
