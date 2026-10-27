import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONTROL_PLANE } from '../config.ts';
import { atomicWrite } from '../plan/store.ts';
import { columnOf } from './hitl.ts';
import type { PilotConfig } from '../config.ts';
import { commit } from './actions.ts';

// Helix's prompts (spec §9.3): a preset per role and level in harness/helix/prompts/, shipped with the app. An
// edit is saved beside its preset as <name>.local.md and wins until it is reset; both are in git. The prompts
// carry judgment only: what Helix may do is the tools' and the floors' business, so an edit can't widen it.

export const promptsDir = (root: string) => join(root, 'harness', 'helix', 'prompts');
// The presets ship with the app's code; a loop's own edits live in its control plane. They are the same folder
// once the app runs from the control plane it serves.
const presetsDir = () => join(CONTROL_PLANE, 'harness', 'helix', 'prompts');

export interface PromptInfo {
  name: string; // assistant, monitor.auto-intrepid
  role: 'assistant' | 'monitor';
  level?: string;
  text: string;
  edited: boolean;
}

export function listPrompts(root: string): PromptInfo[] {
  const dir = presetsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.local.md'))
    .sort()
    .map((f) => readPrompt(root, f.replace(/\.md$/, ''))!);
}

export function readPrompt(root: string, name: string): PromptInfo | undefined {
  if (!/^[a-z]+(\.[a-z-]+)?$/.test(name)) return undefined;
  const preset = join(presetsDir(), `${name}.md`);
  if (!existsSync(preset)) return undefined;
  const local = join(promptsDir(root), `${name}.local.md`);
  const edited = existsSync(local);
  const [role, level] = name.split('.');
  return { name, role: role as PromptInfo['role'], level, text: readFileSync(edited ? local : preset, 'utf8').trim(), edited };
}

export function presetText(root: string, name: string): string | undefined {
  const f = join(presetsDir(), `${name}.md`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined;
}

// The monitor's prompt for the pilot mode and level in force.
export const monitorPromptName = (pilot: PilotConfig) => {
  const c = columnOf(pilot);
  return c === 'intrepid_auto' ? 'monitor.auto-intrepid' : c === 'yolo' ? 'monitor.auto-yolo' : `monitor.active-${c}`;
};

export async function savePrompt(root: string, name: string, text: string): Promise<PromptInfo> {
  const p = readPrompt(root, name);
  if (!p) throw new Error(`no prompt ${name}`);
  const t = text.trim();
  if (!t) throw new Error('a prompt cannot be empty; reset it to its preset instead');
  if (t.length > 20_000) throw new Error('a prompt is at most 20,000 characters');
  const local = join(promptsDir(root), `${name}.local.md`);
  if (t === presetText(root, name)) rmSync(local, { force: true });
  else {
    mkdirSync(promptsDir(root), { recursive: true });
    atomicWrite(local, `${t}\n`);
  }
  if (existsSync(join(root, '.git'))) await commit(root, [relative(root, local)], `Helix: ${name} prompt edited (Daniel, in Helix Loop)`).catch(() => false);
  return readPrompt(root, name)!;
}

export async function resetPrompt(root: string, name: string): Promise<PromptInfo> {
  const p = readPrompt(root, name);
  if (!p) throw new Error(`no prompt ${name}`);
  const local = join(promptsDir(root), `${name}.local.md`);
  if (existsSync(local)) {
    rmSync(local);
    if (existsSync(join(root, '.git'))) await commit(root, [relative(root, local)], `Helix: ${name} prompt reset to its preset (Daniel, in Helix Loop)`).catch(() => false);
  }
  return readPrompt(root, name)!;
}
