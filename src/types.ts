// Shared data shapes for the loop. Plan files (plan/taskset.yaml, plan/milestones.yaml, plan/tasks/*.yaml,
// plan/human/*.yaml) are validated against schema/*.json, which must stay in step with these types.

export const AGENTS = ['claude', 'codex'] as const;
export type AgentName = (typeof AGENTS)[number];

// A product repo the loop builds: a key of the project config's `repos`, which says how to gate it.
export type RepoName = string;

export type TaskStatus = 'ready' | 'claimed' | 'done' | 'needs_human' | 'parked';

// Why kept work did not merge, for the next attempt that starts from it: main changed under it (moved), it
// failed the gate (failed), it was stopped before it finished (cut), or the agent answered BLOCKED (blocked).
export type CarryReason = 'moved' | 'failed' | 'cut' | 'blocked';

export type AttemptOutcome =
  | 'merged'
  | 'gate_failed'
  | 'no_commit'
  | 'conflict'
  | 'forbidden_paths'
  | 'timeout'
  | 'agent_error'
  // Interrupted by the agent's session limit, a host suspension, a transient API error, or a person
  // stopping the pass from the loop app (runs/stop-pass/); these never count towards the attempt cap.
  | 'quota'
  | 'suspended'
  | 'transient'
  | 'stopped';

export const UNCOUNTED_OUTCOMES: readonly AttemptOutcome[] = ['quota', 'suspended', 'transient', 'stopped'];

export interface Attempt {
  agent: AgentName;
  outcome: AttemptOutcome;
  at: string; // ISO time the pass ended
  log: string; // path relative to the control plane, under runs/
  note?: string;
  // The branch this attempt's work is kept on: it passed its own gate, but main changed under it (a rebase
  // conflict, the gate failing on the new main, or an origin that diverged). The next attempt starts from it.
  kept?: string;
}

export interface Task {
  id: string; // T-0001
  repo: RepoName;
  story: string; // the user story it serves (plan/taskset.yaml); its feature, epic and lane follow
  area: string; // module the task owns; two agents never hold the same area at once
  title: string;
  reqs: string[];
  spec: string[]; // section headings or requirement IDs, resolved through spec/index.json
  acceptance: string[];
  blocked_by: string[]; // T-#### or HT-##
  // Written by the Milestones step. placeholder_for: built before these tasks, against a placeholder (they are
  // not in blocked_by). wires: the follow-up that replaces those tasks' placeholders with the real thing.
  placeholder_for?: string[];
  wires?: string[];
  estimate_passes: number;
  priority?: 'fix_first' | 'normal';
  // Pins the task to one agent and picks which of that agent's models runs it (config `models`).
  // Mascot animation and SVG work is pinned to Codex in the design role (Astra).
  agent?: AgentName;
  role?: 'build' | 'design';
  status: TaskStatus;
  // What the last pass that changed the task's state did, in under 144 characters, for the dependency
  // map; written by the loop. The next attempt's prompt reads attempts[].note, never this.
  summary?: string;
  claimed_by: AgentName | null;
  attempts: Attempt[];
  notes?: string;
}

export type HumanStatus = 'todo' | 'in_progress' | 'done';

export interface HumanTask {
  id: string; // HT-01
  title: string;
  story?: string; // the user story it clearly serves; human tasks stay outside the hierarchy and the milestones
  done_check: string;
  lead_time_days: number;
  agent_can_help: 'yes' | 'partly' | 'no';
  handoff_prompt?: string;
  tools?: string[];
  secrets?: { name: string; stored_in: string }[]; // never values
  blocked_by: string[];
  status: HumanStatus;
  notes?: string; // what the owner recorded: the evidence a step is done, or why it waits
}

// ---- The TaskSet's hierarchy (plan/taskset.yaml, plan/taskset.ts): Lane › Epic › Feature › Story › Task ----

export type Timeline = 'code' | 'project';
export type Level = 'lane' | 'epic' | 'feature' | 'story';

export interface StoryDef {
  key: string; // unique across the TaskSet, like every key below the lane
  title: string;
  need: string; // "As a …, I want …, so that …"
  feature: string;
  epic: string;
  lane: string;
}

export interface FeatureDef {
  key: string;
  title: string;
  capability?: string;
  epic: string;
  lane: string;
  stories: string[]; // in reading order
}

export interface EpicDef {
  key: string;
  title: string;
  outcome: string;
  lane: string;
  features: string[];
}

export interface LaneDef {
  key: string;
  repo: RepoName;
  epics: string[];
}

export interface TaskSetDef {
  revision: number;
  milestonesFile?: string; // as taskset.yaml names it; absent in revision 1, before Milestones are planned
  timelines: Timeline[];
  lanes: LaneDef[]; // in reading order; YAML order says nothing about delivery
  epics: Map<string, EpicDef>;
  features: Map<string, FeatureDef>;
  stories: Map<string, StoryDef>;
}

// ---- Helix Milestones (plan/milestones.yaml, plan/milestones.ts): the delivery order ----

export interface MilestoneDef {
  key: string;
  title: string;
  demo: string; // what the owner can see or do once it is reached
  features: string[]; // every story of these features…
  stories: string[]; // …plus these stories, taken from a feature placed later…
  tasks: string[]; // …plus these tasks, taken from a story placed elsewhere
}

export interface Plan {
  tasks: Map<string, Task>;
  human: Map<string, HumanTask>;
  // Read beside the tasks (plan/store.ts loadPlan): the hierarchy, when taskset.yaml reads as version 2, and the
  // milestones in delivery order, when milestones.yaml exists. Validation reports a plan without either.
  taskset?: TaskSetDef;
  milestones?: MilestoneDef[];
}

// ---- Dependency map: computed by map/graph.ts, rendered by map/render.ts ----

export type AgentState = 'available' | 'busy' | 'limited' | 'probing';

// What the loop is doing overall, from the quota table in the design doc §7.4.
export type LoopMode = 'parallel' | 'single:claude' | 'single:codex' | 'paused' | 'idle';

export interface MapNode {
  id: string;
  kind: 'task' | 'human';
  lane: RepoName | 'human';
  title: string;
  milestone?: string; // tasks only: its milestone's title
  area?: string;
  status: TaskStatus | HumanStatus;
  summary?: string; // tasks only: Task.summary
  agent: AgentName | null; // holder while claimed, or the agent whose attempt merged
  reqs: string[];
  blockedBy: string[];
  dependents: string[];
  // Critical-path method, in hours from MapModel.startAt.
  durationHours: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  slack: number;
  critical: boolean;
  latestStart?: string; // ISO date; human tasks only
}

export interface MapAgent {
  name: AgentName;
  state: AgentState;
  model: string;
  tasks: string[]; // the tasks its passes in flight hold, one per slot in use
  slots: number; // the passes it may run at once, as configured
  paced?: number; // fewer slots than that, while its weekly pace holds it back
  pacedUntil?: string; // ISO, with no slot at all: when the pace lets it work again
  resetAt?: string; // ISO, when limited
}

export interface MapModel {
  generatedAt: string;
  startAt: string; // time origin of es/ef/ls/lf
  passHours: number; // hours one estimated pass is worth, from the ledger's actuals
  nodes: MapNode[];
  lanes?: RepoName[]; // the project's repos, in the TaskSet's order; else the order nodes name them
  owner?: string; // who does the human tasks, for the lane's label
  product?: string; // the product's name, for the page's title
  criticalPath: string[]; // ids in order
  agents: MapAgent[];
  mode: LoopMode;
  totals: { tasks: number; done: number; ready: number; claimed: number; needsHuman: number; parked: number };
  projectedFinish: string; // ISO; max of the critical path and total work spread over the agents
  // The people's side: the earliest every human step can be done, with review lead times, and the
  // chain of steps and tasks that sets it (the launch can't open sooner).
  humanFinish?: string;
  humanPath?: string[];
}
