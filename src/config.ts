import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  allow?: string[]; // more Claude Code tool rules a pass may use, as Bash(<command>:*)
}

// Who and what the loop builds for: the product's name, the person who does its human tasks and steers the
// loop, and the time zone dates are written in. The app, Helix and the documents speak in these.
export interface ProjectInfo {
  name: string;
  owner: string;
  timezone: string;
}

export interface Config {
  root: string; // the project: the folder that holds .helix/
  project?: Partial<ProjectInfo>;
  // The prefix of the variables the loop sets for a product repo's scripts (<PREFIX>_GATE_ID, <PREFIX>_E2E_CLIENT,
  // ...): HELIX unless the product's own code reads another. The HELIX_ names are always set too.
  env_prefix?: string;
  git_author?: { name: string; email: string }; // who the loop's own commits and tags are by
  agents: Record<AgentName, AgentConfig>;
  // Each repo the loop builds: its checkout is the project's own code, at <project>/<repo> unless `path` says
  // where (relative to the project). The loop merges into that checkout's main; its passes work in worktrees.
  repos: Record<RepoName, { gate: string; prepare?: string; path?: string }>;
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
    review_paths: string[]; // globs: a release that changes any of them waits for `helix-loop release approve`
  };
  e2e_runner?: { port: number; script: string; timeout_minutes: number; concurrency?: number };
  agent_network?: { allowed_domains: string[]; allow_write: string[] };
  notify: { macos: boolean };
  // The loop app (app/server.ts): its port on 127.0.0.1. A pass wires its builder to the app's MCP endpoint
  // only while the app answers there.
  app?: { port: number };
  // Who decides the decisions the loop would put to a person (app/hitl.ts): the owner at their desk (active), or
  // Helix while they are away (auto), and how much reaches them at each.
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

// The tool's own files (the schemas, Helix's preset prompts, the templates, the skill, the hooks, the fake CLIs
// and the app's page) sit beside src/, from source and from a build alike: the nearest package.json up.
function packageRoot(from: string): string {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'schema'))) return d;
    if (dirname(d) === d) throw new Error(`helix-loop: cannot find its own files above ${from}`);
  }
}
export const PACKAGE_ROOT = packageRoot(dirname(fileURLToPath(import.meta.url)));
export const asset = (...parts: string[]) => join(PACKAGE_ROOT, ...parts);
// A script the tool runs as its own process (the CLI, Claude Code's hook): from source, the .ts file, which
// Node runs as it is; installed, its compiled .js under dist/, since Node strips no types under node_modules.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
export const script = (...parts: string[]) => (FROM_SOURCE ? `${asset(...parts)}.ts` : `${asset('dist', ...parts)}.js`);
export const BIN = script('bin', 'helix-loop');

// A project keeps everything Helix Loop needs in one hidden folder: its spec, its TaskSet, its config, its
// app settings, and (ignored by git) the loop's runs, the product repos and the passes' worktrees.
export const HELIX_DIR = '.helix';
export const configPath = (root: string) => join(root, HELIX_DIR, 'config.yaml');
// A pass's log, as the ledger and the plan record it: relative to .helix/ (runs/logs/<day>/<task>-<agent>-<n>.log).
export const logFile = (root: string, rel: string) => join(root, HELIX_DIR, rel);

// The project a command acts on: the nearest folder up from `from` with a .helix/config.yaml, as git finds
// its repository.
export function findProject(from = process.cwd()): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(configPath(d))) return d;
    if (dirname(d) === d) return undefined;
  }
}

export class NoProjectError extends Error {}
export function projectRoot(explicit?: string): string {
  const root = explicit ?? process.env.HELIX_PROJECT ?? findProject();
  if (!root) throw new NoProjectError('Not in a Helix Loop project (no .helix/config.yaml here or above). Run `helix-loop init` to start one, or pass --root.');
  if (!existsSync(configPath(root))) throw new NoProjectError(`${root} is not a Helix Loop project: ${configPath(root)} is missing. Run \`helix-loop init\` there.`);
  return resolve(root);
}

// The identity on the loop's own commits (plan updates, a pass's leftover work) and release tags: the config's
// git_author. One process acts for one project, so the last config loaded names it for helpers that have no
// config at hand.
let lastAuthor: Config['git_author'];
export function gitAuthor(config?: Config): string[] {
  const a = (config ? config.git_author : lastAuthor) ?? { name: 'Helix Loop', email: 'helix-loop@localhost' };
  return ['-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`];
}

// Variables for a product repo's scripts, under the project's prefix and under HELIX_.
export function productEnv(config: Config, vars: Record<string, string>): Record<string, string> {
  const prefix = config.env_prefix ?? 'HELIX';
  return Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => [[`HELIX_${k}`, v], [`${prefix}_${k}`, v]]));
}

export function projectInfo(config: Config): ProjectInfo {
  return {
    name: config.project?.name ?? basename(config.root),
    owner: config.project?.owner ?? 'the owner',
    timezone: config.project?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// Each agent's weekly pacing target, for the metrics page's pace lines.
export function weeklyTargets(config: Config): Record<string, number | undefined> {
  return Object.fromEntries(AGENTS.map((a) => [a, config.agents[a].weekly_target]));
}

export function loadConfig(root: string, file = configPath(root)): Config {
  const raw = parse(readFileSync(file, 'utf8')) as Omit<Config, 'root'>;
  for (const a of AGENTS) {
    if (!raw.agents?.[a]) throw new Error(`config: agents.${a} is missing`);
  }
  // The repos the loop builds are the project's own: each needs the command that gates it.
  if (!raw.repos || !Object.keys(raw.repos).length) throw new Error('config: repos must name at least one repo to build');
  for (const [r, c] of Object.entries(raw.repos)) {
    if (!c?.gate) throw new Error(`config: repos.${r}.gate is missing`);
    // The project's own folder holds the plan, which the loop commits as it goes: a repo there would have the
    // loop's plan commits and its merges racing on one main. Inside .helix/ the code would be hidden.
    const at = resolve(root, c.path ?? r);
    if (at === resolve(root)) throw new Error(`config: repos.${r}.path can't be the project folder itself; keep the code in a folder of its own, such as ${r}/`);
    if (at === resolve(root, HELIX_DIR) || at.startsWith(resolve(root, HELIX_DIR) + sep)) throw new Error(`config: repos.${r}.path is inside ${HELIX_DIR}/, where the code would be hidden; put it beside it, such as ${r}/`);
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
  lastAuthor = raw.git_author;
  return { ...raw, release: { ...raw.release, review_paths: review }, root };
}

// A repo's gate and prepare steps; a task naming a repo the config doesn't is refused by validation first.
// A repo's checkout: the project's code, where people read and run it, and where the loop merges each pass.
export function repoDir(config: Pick<Config, 'root' | 'repos'>, repo: RepoName): string {
  return resolve(config.root, config.repos[repo]?.path ?? repo);
}

export function repoConfig(config: Config, repo: RepoName): { gate: string; prepare?: string; path?: string } {
  const r = config.repos[repo];
  if (!r) throw new Error(`config: no repo ${repo} under repos`);
  return r;
}

// Where everything lives in a project, under its .helix/ folder. One place, so tests can point a whole loop at a
// temporary directory.
export function paths(root: string) {
  const h = join(root, HELIX_DIR);
  return {
    home: h,
    config: join(h, 'config.yaml'),
    spec: specFile(join(h, 'spec')),
    specSections: join(h, 'spec', 'sections'),
    specIndex: join(h, 'spec', 'index.json'),
    clarifications: join(h, 'spec', 'clarifications.md'), // answers sent into the spec, for the loop engineer to fold in
    plan: join(h, 'plan'),
    taskset: join(h, 'plan', 'taskset.yaml'),
    milestones: join(h, 'plan', 'milestones.yaml'),
    history: join(h, 'plan', 'history'),
    tasks: join(h, 'plan', 'tasks'),
    human: join(h, 'plan', 'human'),
    syntheticReqs: join(h, 'plan', 'synthetic-reqs.yaml'),
    deferredReqs: join(h, 'plan', 'deferred-reqs.yaml'),
    implementationPlan: join(h, 'plan', 'ImplementationPlan.md'),
    humanPlan: join(h, 'plan', 'HumanImplementationPlan.md'),
    map: join(h, 'plan', 'DependencyMap.html'),
    prompts: join(h, 'prompts'), // build.md, the build prompt template
    helix: join(h, 'helix'), // the owner's edits to Helix's prompts, and the rules their ratings taught it
    appSettings: join(h, 'app.yaml'), // the project's app settings
    schema: asset('schema'), // the tool's own
    hooks: asset('hooks'),
    runs: join(h, 'runs'),
    ledger: join(h, 'runs', 'runs.jsonl'),
    metrics: join(h, 'runs', 'metrics'), // the metrics page's versions (metrics/archive.ts)
    approvals: join(h, 'runs', 'approvals'),
    agentsState: join(h, 'runs', 'agents.json'),
    logs: join(h, 'runs', 'logs'),
    stopFile: join(h, 'runs', 'STOP'),
    pause: join(h, 'runs', 'PAUSE'), // while it exists no new pass starts, and the loop waits instead of exiting
    stopPass: join(h, 'runs', 'stop-pass'), // <task>.json: the app asks for that task's pass to stop
    lock: join(h, 'runs', 'loop.lock'),
    live: join(h, 'runs', 'live.json'), // the passes in flight (live.ts)
    reports: join(h, 'runs', 'reports.jsonl'), // what builders report over MCP (app/mcp.ts)
    steward: join(h, 'runs', 'steward.jsonl'), // Helix's turns from before it had that name: still counted in today's spend
    helixTurns: join(h, 'runs', 'helix.jsonl'), // each Helix turn, its role and its cost (app/helix.ts)
    hitl: join(h, 'runs', 'hitl.jsonl'), // what Helix resolved on the owner's behalf, and their ratings (app/hitl.ts)
    incidents: join(h, 'runs', 'incidents.jsonl'), // incidents' fixes and what became of them (app/incidents.ts)
    changes: join(h, 'runs', 'changes.jsonl'), // each plan change the app applied, for undo (app/changes.ts)
    threads: join(h, 'runs', 'threads'), // comments and Helix's threads (app/threads.ts)
    dryRun: join(h, 'runs', 'dry-run'), // the dry run's own project (dryrun.ts)
    worktrees: join(h, 'worktrees'),
  };
}

// The project's spec: .helix/spec/spec.md, or the one other Markdown file there (the spec may keep its title as
// its name).
export function specFile(dir: string): string {
  const named = join(dir, 'spec.md');
  if (existsSync(named) || !existsSync(dir)) return named;
  const md = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'clarifications.md');
  return md.length === 1 ? join(dir, md[0]!) : named;
}
export type Paths = ReturnType<typeof paths>;
