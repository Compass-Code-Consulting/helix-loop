import { run } from '../proc.ts';
import type { AgentName } from '../types.ts';

// How a CLI is signed in. Builders run only on a subscription, never on an API key: a key bills per token,
// and an unattended loop is where costs run away (DECISIONS.md, 2026-10-25). The loop asks the CLI itself,
// because the builder environment (adapter.ts builderEnv) already keeps keys in the shell from reaching it.

export interface SignIn {
  subscription: boolean;
  method: string; // as shown to Daniel: "subscription", "API key", "Console", "signed out", or what the CLI said
  detail?: string;
}

export async function signIn(agent: AgentName, command: string, env: NodeJS.ProcessEnv): Promise<SignIn> {
  const args = agent === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
  let res;
  try {
    res = await run(command, args, { cwd: process.cwd(), env, timeoutMs: 20_000 });
  } catch (e) {
    return { subscription: false, method: 'not installed', detail: (e as Error).message };
  }
  const text = `${res.stdout}\n${res.stderr}`.trim();
  return agent === 'claude' ? claudeSignIn(text) : codexSignIn(text);
}

// `claude auth status --json`: `authMethod` is `claude.ai` for a Claude subscription.
export function claudeSignIn(text: string): SignIn {
  let s: { loggedIn?: boolean; authMethod?: string };
  try {
    s = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return { subscription: false, method: 'unknown', detail: text.slice(0, 300) };
  }
  if (!s.loggedIn) return { subscription: false, method: 'signed out' };
  if (s.authMethod === 'claude.ai') return { subscription: true, method: 'subscription' };
  const method = /console/i.test(s.authMethod ?? '') ? 'Console' : /key/i.test(s.authMethod ?? '') ? 'API key' : String(s.authMethod ?? 'unknown');
  return { subscription: false, method };
}

// `codex login status`: "Logged in using ChatGPT" for a ChatGPT subscription.
export function codexSignIn(text: string): SignIn {
  if (/logged in using chatgpt/i.test(text)) return { subscription: true, method: 'subscription' };
  if (/api key/i.test(text)) return { subscription: false, method: 'API key' };
  if (/not logged in/i.test(text)) return { subscription: false, method: 'signed out' };
  return { subscription: false, method: 'unknown', detail: text.slice(0, 300) };
}
