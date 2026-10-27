import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { atomicWrite } from '../plan/store.ts';
import { AGENTS, type AgentName } from '../types.ts';

// runs/app.yaml: this machine's Helix Loop settings. Not in git, like the rest of runs/: which CLI runs Helix
// depends on what is installed and signed in here, and the rest is where Daniel left the page.

export interface AppSettings {
  helix?: { assistant?: AgentName; monitor?: AgentName };
  dismissed?: string[]; // items Daniel dismissed on Home
  lastHome?: { at: string; finish?: number; mode?: 'active' | 'auto' }; // the last time he looked at Home
  ui?: Record<string, string | number | boolean>; // panel widths and toggles: the task column, Wrap, folds
}

const agent = (a: unknown): AgentName | undefined => (AGENTS.includes(a as AgentName) ? (a as AgentName) : undefined);

export function loadSettings(file: string): AppSettings {
  if (!existsSync(file)) return {};
  try {
    const s = (parse(readFileSync(file, 'utf8')) ?? {}) as AppSettings & { steward?: AgentName };
    const ui = s.ui && typeof s.ui === 'object' ? Object.fromEntries(Object.entries(s.ui).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))) : undefined;
    return {
      // Before Helix had two roles, the one agent setting was the steward's: now the assistant's.
      helix: { assistant: agent(s.helix?.assistant) ?? agent(s.steward), monitor: agent(s.helix?.monitor) },
      dismissed: Array.isArray(s.dismissed) ? s.dismissed.map(String) : [],
      lastHome: s.lastHome && typeof s.lastHome.at === 'string' ? s.lastHome : undefined,
      ...(ui ? { ui } : {}),
    };
  } catch {
    return {};
  }
}

export function saveSettings(file: string, s: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, `# Helix Loop's settings on this machine (helix-loop app); not in git.\n${stringify({ ...s, dismissed: s.dismissed?.slice(-2000) })}`);
}
