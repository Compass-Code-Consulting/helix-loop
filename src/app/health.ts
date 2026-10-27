import { builderEnv } from '../agents/adapter.ts';
import { signIn } from '../agents/auth.ts';
import { claudeAdapter } from '../agents/claude.ts';
import { codexAdapter } from '../agents/codex.ts';
import type { Config } from '../config.ts';
import { run } from '../proc.ts';
import { AGENTS, type AgentName } from '../types.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Settings › Agents (spec §12): whether each CLI is installed, signed in with its subscription, holding a Helix
// API key, and working, with the fixes Daniel can run from the page. Builders need a subscription; Helix may
// use either. Keys live only in the macOS keychain, never in a file or a log.

export type Light = 'green' | 'amber' | 'red' | 'off';

export interface AgentHealth {
  agent: AgentName;
  checkedAt: string;
  installed: { light: Light; version?: string; detail?: string };
  subscription: { light: Light; method: string; detail?: string };
  key: { light: Light }; // off when no Helix key is saved; green when one is
  working: { light: Light; detail?: string; resetAt?: number };
  builder: boolean; // may build: installed, on its subscription, working
  helix: boolean; // may run Helix: installed, a subscription or a key, working
}

export const KEY_SERVICE: Record<AgentName, string> = {
  claude: 'Helix Loop: Helix Anthropic API key',
  codex: 'Helix Loop: Helix OpenAI API key',
};
// The keychain items from before Helix was named, still read until a key is saved under the new name.
const OLD_KEY_SERVICE: Record<AgentName, string> = {
  claude: 'Mushy loop: steward Anthropic API key',
  codex: 'Mushy loop: steward OpenAI API key',
};
const KEY_ACCOUNT = 'mushy-loop';
// The variable each CLI takes a key from in a headless run, set only in Helix's own process.
export const KEY_ENV: Record<AgentName, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY' };

export const INSTALL: Record<AgentName, string[]> = {
  claude: ['brew', 'install', '--cask', 'claude-code'],
  codex: ['npm', 'install', '-g', '@openai/codex'],
};
export const SIGN_IN: Record<AgentName, string[]> = {
  claude: ['auth', 'login', '--claudeai'],
  codex: ['login', '--device-auth'],
};

export async function hasKey(agent: AgentName): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  for (const service of [KEY_SERVICE[agent], OLD_KEY_SERVICE[agent]]) {
    const r = await run('security', ['find-generic-password', '-s', service, '-a', KEY_ACCOUNT], { cwd: tmpdir(), timeoutMs: 10_000 }).catch(() => undefined);
    if (r?.code === 0) return true;
  }
  return false;
}

export async function readKey(agent: AgentName): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  for (const service of [KEY_SERVICE[agent], OLD_KEY_SERVICE[agent]]) {
    const r = await run('security', ['find-generic-password', '-s', service, '-a', KEY_ACCOUNT, '-w'], { cwd: tmpdir(), timeoutMs: 10_000 }).catch(() => undefined);
    if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

// Saves the key through `security -i`, which reads its command from stdin, so the key never appears in a
// process list. The quotes are escaped for its parser; a key with a line break is refused.
export async function saveKey(agent: AgentName, key: string): Promise<void> {
  const k = key.trim();
  if (!k || /[\r\n]/.test(k) || k.length > 512) throw new Error('that does not look like an API key');
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const r = await run('security', ['-i'], {
    cwd: tmpdir(),
    stdin: `add-generic-password -U -s ${q(KEY_SERVICE[agent])} -a ${q(KEY_ACCOUNT)} -w ${q(k)}\n`,
    timeoutMs: 15_000,
  });
  if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`the keychain refused the key: ${r.stderr.replace(k, '***').trim().slice(0, 200)}`);
}

export async function deleteKey(agent: AgentName): Promise<void> {
  for (const service of [KEY_SERVICE[agent], OLD_KEY_SERVICE[agent]]) await run('security', ['delete-generic-password', '-s', service, '-a', KEY_ACCOUNT], { cwd: tmpdir(), timeoutMs: 10_000 }).catch(() => undefined);
}

const TTL_MS = 10 * 60_000;
const cache = new Map<AgentName, AgentHealth>();

export async function health(config: Config, opts: { refresh?: boolean } = {}): Promise<AgentHealth[]> {
  return Promise.all(AGENTS.map((a) => agentHealth(config, a, opts.refresh)));
}

async function agentHealth(config: Config, agent: AgentName, refresh = false): Promise<AgentHealth> {
  const cached = cache.get(agent);
  if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < TTL_MS) return cached;
  const command = config.agents[agent].command;
  const env = builderEnv(process.env);
  const h: AgentHealth = {
    agent,
    checkedAt: new Date().toISOString(),
    installed: { light: 'red' },
    subscription: { light: 'off', method: 'unknown' },
    key: { light: (await hasKey(agent)) ? 'green' : 'off' },
    working: { light: 'off' },
    builder: false,
    helix: false,
  };
  const v = await run(command, ['--version'], { cwd: tmpdir(), env, timeoutMs: 20_000 }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  if (v.code !== 0) {
    h.installed = { light: 'red', detail: /ENOENT/.test(v.stderr) ? `${command} is not on PATH` : v.stderr.trim().slice(0, 200) };
    cache.set(agent, h);
    return h;
  }
  h.installed = { light: 'green', version: v.stdout.trim().split('\n')[0] };
  const s = await signIn(agent, command, env);
  h.subscription = { light: s.subscription ? 'green' : 'red', method: s.method, detail: s.detail };
  // One tiny request, as the loop's probe makes at a reset: it shows a limit as amber, with its reset time.
  if (s.subscription || h.key.light === 'green') h.working = await probe(config, agent, s.subscription ? {} : { [KEY_ENV[agent]]: (await readKey(agent)) ?? '' });
  h.builder = h.installed.light === 'green' && s.subscription && h.working.light === 'green';
  h.helix = h.installed.light === 'green' && (s.subscription || h.key.light === 'green') && h.working.light === 'green';
  cache.set(agent, h);
  return h;
}

async function probe(config: Config, agent: AgentName, extraEnv: Record<string, string>): Promise<AgentHealth['working']> {
  const adapter = agent === 'claude' ? claudeAdapter(config.agents.claude, config) : codexAdapter(config.agents.codex, config);
  const dir = mkdtempSync(join(tmpdir(), 'mushy-probe-'));
  const inv = adapter.probe(dir);
  const res = await run(inv.cmd, inv.args, { cwd: dir, stdin: inv.stdin, env: { ...builderEnv(process.env), ...inv.env, ...extraEnv }, timeoutMs: 120_000 }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  const r = await adapter.interpret(res.stdout, res.stderr, res.code, Date.now());
  if (r.kind === 'ok') return { light: 'green' };
  if (r.kind === 'limited') return { light: 'amber', detail: 'at its usage limit', resetAt: r.resetAt ?? undefined };
  return { light: 'red', detail: (r.detail ?? r.kind).slice(0, 300) };
}

export function forget(agent: AgentName): void {
  cache.delete(agent);
}
