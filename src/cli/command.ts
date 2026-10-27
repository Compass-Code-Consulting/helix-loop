// A CLI command, declared once: its name, what it takes and what it does. The dispatcher (main.ts), every
// `--help` and the reference in docs/cli.md (help.ts) are all generated from these declarations, so the three
// can never disagree.

export const GROUPS = [
  'Start a project',
  'Spec and TaskSet',
  'The loop',
  'Tasks',
  'Human tasks',
  'What waits on you',
  'Helix',
  'Settings',
  'Releases',
  'The app',
] as const;
export type Group = (typeof GROUPS)[number];

export interface Arg {
  name: string;
  description: string;
  optional?: boolean;
  variadic?: boolean; // takes the rest of the arguments
}

export interface Option {
  type: 'string' | 'boolean';
  description: string;
  short?: string;
  value?: string; // how a string option's value reads in help: "N", "dir"
  multiple?: boolean;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Context {
  root: string; // the project, for commands that need one; '' for those that don't
  args: string[];
  opts: Values;
  json: boolean; // --json: machine-readable output, for commands that list or show
  out: (line?: string) => void;
  err: (line: string) => void;
  interactive: boolean; // a person at a terminal, who can answer questions
}

export interface Command {
  name: string; // the words that call it: "task hand-back"
  group: Group;
  summary: string; // one line, for the command list
  description?: string; // a few sentences, one per line, for its own --help and the docs
  args?: Arg[];
  options?: Record<string, Option>;
  examples?: [string, string][]; // [the command line, what it does]
  project?: false; // runs outside a project (init, skill install, doctor)
  json?: true; // takes --json
  hidden?: true; // left out of the command list (the docs generator, aliases)
  run(ctx: Context): Promise<number | void> | number | void;
}

// A failure the user can fix, said plainly: printed without a stack, exit 1 (or the code given).
export class UsageError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

export const define = (c: Command): Command => c;

// The string an option holds, if any.
export const str = (opts: Values, name: string): string | undefined => {
  const v = opts[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.at(-1) : undefined;
};
