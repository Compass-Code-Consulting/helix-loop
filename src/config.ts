import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AGENTS, type AgentName, type RepoName } from './types.ts';

export type Role = 'build' | 'design' | 'plan' | 'review';

export interface ModelChoice {
  model: string;
  effort: string;
}

export interface AgentConfig {
  enabled: boolean;
  slots: number;
  weekly_target?: number; // the share of the subscription's weekly window to have used by its reset (quota.ts paceSlots)
  command: string;
  models: Record<Role, ModelChoice>;
}

export interface Config {
  root: string; // the control plane
  agents: Record<AgentName, AgentConfig>;
  repos: Record<RepoName, { gate: string; prepare?: string }>;
  limits: {
    pass_timeout_minutes: number;
    gate_timeout_minutes: number;
    concurrent_gates?: number; // gates and re-gates running at once, across all passes (default 2)
    prompt_budget_bytes: number;
    agents_md_budget_bytes: number;
    max_attempts: number;
    max_conflicts: number; // merge conflicts a task may hit before it goes to a person; they are not attempts
    daily_budget_usd: Record<AgentName, number>;
    codex_price_per_mtok: { input: number; cached_input: number; output: number };
    suspension_threshold_seconds: number;
    unknown_reset_backoff_minutes: { first: number; max: number };
  };
  forbidden_paths: string[];
  forbidden_exceptions?: string[]; // paths a forbidden pattern would catch that may still change, such as .env.example
  restricted_paths: Record<string, string>;
  push: boolean;
  union_merge_paths?: string[]; // files many tasks append to, merged with git's union driver (git.ts ensureUnionMerge)
  relock?: Record<string, string>; // lockfile name → the command that regenerates it, for rebase conflicts (merge.ts)
  json_merge?: Record<string, string>; // manifest name → the command that formats it after a key-by-key merge (merge.ts)
  metrics_every_passes?: number; // a new version of the metrics page every N passes (metrics/archive.ts)
  release: {
    every_merged_tasks: number;
    hold_until?: Partial<Record<RepoName, string>>; // repo → the human task (HT-##) its releases wait for
    review_paths: string[]; // globs: a release that changes any of them waits for approve-release
  };
  e2e_runner?: { port: number; script: string; timeout_minutes: number; concurrency?: number };
  agent_network?: { allowed_domains: string[]; allow_write: string[] };
  notify: { macos: boolean };
  // The loop app (app/server.ts): its port on 127.0.0.1. A pass wires its builder to the app's MCP endpoint
  // only while the app answers there.
  app?: { port: number };
  // Who decides the decisions the loop would put to a person (app/hitl.ts): Daniel at his desk (active), or
  // Helix while he is away (auto), and how much reaches him at each.
  pilot?: Partial<PilotConfig>;
  // Where each kind of builder feedback goes (app/hitl.ts feedbackRule), with per-lane overrides.
  feedback?: FeedbackConfig;
  // Helix, the app's assistant: its monitor role is off until turned on, since every turn draws on a subscription.
  // Its level is a preset (MONITOR_PRESETS); a cap, heartbeat or model set here overrides the level's.
  helix?: {
    monitor?: {
      enabled?: boolean;
      level?: MonitorLevel;
      agent?: AgentName;
      daily_budget_usd?: number;
      every_minutes?: number;
      model?: Partial<Record<AgentName, ModelChoice>>;
    };
  };
}

// How much Helix's monitor watches (spec §9.1). Light, the default, takes a turn only when something needs
// judgment, on a cheaper model: the monitor shares the builders' subscription, and most of what happens in a
// loop (a merge, a first failure the retry will fix) needs none.
export const MONITOR_LEVELS = ['light', 'standard', 'thorough'] as const;
export type MonitorLevel = (typeof MONITOR_LEVELS)[number];

export const MONITOR_PRESETS: Record<MonitorLevel, { budgetUsd: number; everyMinutes?: number; everyPass: boolean; passReads: boolean; effort: string }> = {
  light: { budgetUsd: 5, everyPass: false, passReads: false, effort: 'low' },
  standard: { budgetUsd: 15, everyMinutes: 30, everyPass: false, passReads: true, effort: 'medium' },
  thorough: { budgetUsd: 30, everyMinutes: 15, everyPass: true, passReads: true, effort: 'high' },
};

export interface MonitorSettings {
  enabled: boolean;
  level: MonitorLevel;
  budgetUsd: number;
  budgetSet: boolean; // daily_budget_usd is in the config, so it holds whatever the level
  everyMinutes?: number; // the heartbeat while the loop runs; none on light
  everyPass: boolean; // a turn after every pass and report, not only those that need judgment
  passReads: boolean; // one-line reads of running passes (note_pass)
}

// The monitor's settings: its level's preset, with what the config sets explicitly over it.
export function monitorOf(config: Config, level?: MonitorLevel): MonitorSettings {
  const m = config.helix?.monitor;
  const l = level ?? m?.level ?? 'light';
  const preset = MONITOR_PRESETS[l];
  return {
    enabled: !!m?.enabled,
    level: l,
    budgetUsd: m?.daily_budget_usd ?? preset.budgetUsd,
    budgetSet: m?.daily_budget_usd !== undefined,
    // Light never takes a turn on a schedule: that is what makes it light.
    everyMinutes: l === 'light' ? undefined : (m?.every_minutes ?? preset.everyMinutes),
    everyPass: preset.everyPass,
    passReads: preset.passReads,
  };
}

// The model a monitor turn runs on. Light and standard on Claude are Sonnet: grouping, naming and routing need
// no Opus, and on Opus standard's half-hourly turns alone would reach its cap; on Codex the build model.
// Thorough uses the agent's plan model.
export function monitorModel(config: Config, agent: AgentName, level: MonitorLevel): ModelChoice {
  const set = config.helix?.monitor?.model?.[agent];
  if (set) return set;
  const effort = MONITOR_PRESETS[level].effort;
  if (level === 'thorough') return { model: config.agents[agent].models.plan.model, effort };
  return { model: agent === 'claude' ? 'claude-sonnet-5-5' : config.agents[agent].models.build.model, effort };
}

export type PilotMode = 'active' | 'auto';
export type ActiveLevel = 'cautious' | 'prudent' | 'intrepid';
export type AutoLevel = 'intrepid' | 'yolo';
export interface PilotConfig {
  mode: PilotMode;
  active_level: ActiveLevel;
  auto_level: AutoLevel;
  record: boolean; // record what Helix resolves on Auto-pilot (runs/hitl.jsonl)
  table?: Record<string, Partial<Record<'cautious' | 'prudent' | 'intrepid' | 'intrepid_auto' | 'yolo', string>>>;
}

export const FEEDBACK_KINDS = ['spec_question', 'gate_failure', 'flaky_test', 'blocked_on_human', 'credential_missing', 'scope_grew', 'conflict', 'environment'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export interface FeedbackRule {
  send_to: 'inbox' | 'helix' | 'off';
  after: string; // 'first', 'task:N' (N times on one task) or 'tasks:N' (on N tasks)
  pause: boolean; // stop the pass at once
  notify: boolean; // a macOS notification
}
export type FeedbackRules = Partial<Record<FeedbackKind, Partial<FeedbackRule>>>;
export type FeedbackConfig = FeedbackRules & { lanes?: Partial<Record<string, FeedbackRules>> };

export const CONTROL_PLANE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each agent's weekly pacing target, for the metrics page's pace lines.
export function weeklyTargets(config: Config): Record<string, number | undefined> {
  return Object.fromEntries(AGENTS.map((a) => [a, config.agents[a].weekly_target]));
}

export function loadConfig(root = CONTROL_PLANE, file = join(root, 'harness', 'config.yaml')): Config {
  const raw = parse(readFileSync(file, 'utf8')) as Omit<Config, 'root'>;
  for (const a of AGENTS) {
    if (!raw.agents?.[a]) throw new Error(`config: agents.${a} is missing`);
  }
  // The repos the loop builds are the project's own: each needs the command that gates it.
  if (!raw.repos || !Object.keys(raw.repos).length) throw new Error('config: repos must name at least one repo to build');
  for (const [r, c] of Object.entries(raw.repos)) {
    if (!c?.gate) throw new Error(`config: repos.${r}.gate is missing`);
  }
  // A misspelt repo here would hold nothing, and that repo would release unreviewed.
  for (const [r, step] of Object.entries(raw.release?.hold_until ?? {})) {
    if (!raw.repos[r]) throw new Error(`config: release.hold_until.${r} is not a repo`);
    if (!/^HT-\d+$/.test(String(step))) throw new Error(`config: release.hold_until.${r} must name a human task (HT-##), not ${step}`);
  }
  const level = raw.helix?.monitor?.level;
  if (level !== undefined && !(MONITOR_LEVELS as readonly string[]).includes(level)) throw new Error(`config: helix.monitor.level is one of ${MONITOR_LEVELS.join(', ')}, not ${level}`);
  // What runs with production's secrets: CI workflows and actions, and the infrastructure code the deploy runs.
  const review = raw.release?.review_paths ?? ['.github/**', 'infra/**'];
  if (!Array.isArray(review) || !review.length || review.some((g) => typeof g !== 'string' || !g)) {
    throw new Error('config: release.review_paths must list at least one path glob; an empty list would release anything unreviewed');
  }
  return { ...raw, release: { ...raw.release, review_paths: review }, root };
}

// A repo's gate and prepare steps; a task naming a repo the config doesn't is refused by validation first.
export function repoConfig(config: Config, repo: RepoName): { gate: string; prepare?: string } {
  const r = config.repos[repo];
  if (!r) throw new Error(`config: no repo ${repo} under repos`);
  return r;
}

// Where everything lives, relative to the control plane. One place, so tests can point a whole
// loop at a temporary directory.
export function paths(root: string) {
  return {
    spec: join(root, 'spec', 'Mushy — Technical Product Specification.md'),
    specSections: join(root, 'spec', 'sections'),
    specIndex: join(root, 'spec', 'index.json'),
    tasks: join(root, 'plan', 'tasks'),
    human: join(root, 'plan', 'human'),
    schema: join(root, 'plan', 'schema'),
    syntheticReqs: join(root, 'plan', 'synthetic-reqs.yaml'),
    map: join(root, 'plan', 'Mushy.LoopEngineering.DependencyMap.html'),
    prompts: join(root, 'prompts'),
    runs: join(root, 'runs'),
    ledger: join(root, 'runs', 'runs.jsonl'),
    metrics: join(root, 'runs', 'metrics'), // the metrics page's versions (metrics/archive.ts)
    approvals: join(root, 'runs', 'approvals'),
    agentsState: join(root, 'runs', 'agents.json'),
    logs: join(root, 'runs', 'logs'),
    stopFile: join(root, 'runs', 'STOP'),
    pause: join(root, 'runs', 'PAUSE'), // while it exists no new pass starts, and the loop waits instead of exiting
    stopPass: join(root, 'runs', 'stop-pass'), // <task>.json: the loop app asks for that task's pass to stop
    lock: join(root, 'runs', 'loop.lock'),
    repos: join(root, 'repos'),
    worktrees: join(root, 'worktrees'),
    hooks: join(root, 'harness', 'hooks'),
    live: join(root, 'runs', 'live.json'), // the passes in flight (live.ts)
    reports: join(root, 'runs', 'reports.jsonl'), // what builders report over MCP (app/mcp.ts)
    steward: join(root, 'runs', 'steward.jsonl'), // the steward's turns before it was renamed Helix: still counted in today's spend
    helixTurns: join(root, 'runs', 'helix.jsonl'), // each Helix turn, its role and its cost (app/helix.ts)
    hitl: join(root, 'runs', 'hitl.jsonl'), // what Helix resolved on Daniel's behalf, and his ratings (app/hitl.ts)
    incidents: join(root, 'runs', 'incidents.jsonl'), // incidents' fixes and what became of them (app/incidents.ts)
    changes: join(root, 'runs', 'changes.jsonl'), // each plan change the app applied, for undo (app/changes.ts)
    helix: join(root, 'harness', 'helix'), // Helix's prompts and the rules Daniel's ratings taught it, in git
    clarifications: join(root, 'spec', 'clarifications.md'), // answers sent into the spec, for the loop engineer to fold in
    threads: join(root, 'runs', 'threads'), // comments and steward threads (app/threads.ts)
    appSettings: join(root, 'runs', 'app.yaml'), // this machine's loop app settings
    dryRun: join(root, 'runs', 'dry-run'), // the dry run's own control plane (dryrun.ts)
  };
}
export type Paths = ReturnType<typeof paths>;
