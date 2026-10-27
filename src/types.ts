// Shared data shapes for the loop. Plan files (plan/tasks/*.yaml, plan/human/*.yaml) are validated
// against plan/schema/*.json, which must stay in step with these types.

export const AGENTS = ['claude', 'codex'] as const;
export type AgentName = (typeof AGENTS)[number];

// A product repo the loop builds: a key of the project config's `repos`, which says how to gate it.
export type RepoName = string;

// A milestone of the plan, in the order the TaskSet declares (plan/stages.ts). Optional: a plan without
// stages has no stage gating.
export type Stage = string;

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
  stage?: Stage; // the milestone it belongs to, when the plan has stages
  area: string; // module the task owns; two agents never hold the same area at once
  feature?: string; // product area the plan documents group it under (a planner's name in plan/planners.yaml)
  epic?: string; // the epic's key in its lane in plan/taskset.yaml; the lane is the task's repo
  title: string;
  reqs: string[];
  spec: string[]; // section headings or requirement IDs, resolved through spec/index.json
  acceptance: string[];
  blocked_by: string[]; // T-#### or HT-##
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
  done_check: string;
  lead_time_days: number;
  agent_can_help: 'yes' | 'partly' | 'no';
  handoff_prompt?: string;
  tools?: string[];
  secrets?: { name: string; stored_in: string }[]; // never values
  blocked_by: string[];
  status: HumanStatus;
  notes?: string; // what Daniel recorded: the evidence a step is done, or why it waits
}

export interface Plan {
  tasks: Map<string, Task>;
  human: Map<string, HumanTask>;
  // The plan's stages in order, from the TaskSet; when absent, those its tasks name (plan/stages.ts stagesOf).
  stages?: Stage[];
  stageTitles?: Record<Stage, string>;
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
  stage?: Stage;
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
