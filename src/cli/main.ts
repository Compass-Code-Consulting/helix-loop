import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { asset, NoProjectError, projectRoot } from '../config.ts';
import { UsageError, type Command, type Context, type Values } from './command.ts';
import { commandHelp, GLOBAL_OPTIONS, overview } from './help.ts';
import { COMMANDS } from './registry.ts';

// The CLI's dispatcher: finds the command the leading words name ("task hand-back"), parses its options, finds
// the project, and runs it. Errors a person can fix print as one plain sentence, without a stack.

export const VERSION = (JSON.parse(readFileSync(asset('package.json'), 'utf8')) as { version: string }).version;

// The command named by the most leading words, so "task" and "task show" can both exist.
export function findCommand(words: string[]): { command: Command; rest: string[] } | undefined {
  for (let n = Math.min(3, words.length); n > 0; n--) {
    const name = words.slice(0, n).join(' ');
    const command = COMMANDS.find((c) => c.name === name);
    if (command) return { command, rest: words.slice(n) };
  }
  return undefined;
}

function closest(name: string): string | undefined {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i]![j] = Math.min(m[i - 1]![j]! + 1, m[i]![j - 1]! + 1, m[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length]![b.length]!;
  };
  const best = COMMANDS.filter((c) => !c.hidden).map((c) => ({ c, d: d(name, c.name) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(name.length / 3)) ? best.c.name : undefined;
}

export async function main(argv: string[], io = { out: (s = '') => console.log(s), err: (s: string) => console.error(s) }): Promise<number> {
  // Global options may come before the command too ("helix-loop --root ~/acme doctor"): they move after it.
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const name = argv[i]!.replace(/^--?/, '').split('=')[0]!;
    const o = Object.entries(GLOBAL_OPTIONS).find(([n, x]) => n === name || x.short === name)?.[1];
    if (!o) break;
    lead.push(argv[i]!);
    if (o.type === 'string' && !argv[i]!.includes('=') && i + 1 < argv.length) lead.push(argv[++i]!);
    i++;
  }
  const words: string[] = [];
  for (const a of argv.slice(i)) {
    if (a.startsWith('-')) break;
    words.push(a);
  }
  const flags = [...argv.slice(i + words.length), ...lead];
  if (!words.length || words[0] === 'help') {
    const target = words[0] === 'help' ? findCommand(words.slice(1)) : undefined;
    if (flags.includes('--version') || flags.includes('-v')) return io.out(VERSION), 0;
    io.out(target ? commandHelp(target.command) : overview(COMMANDS, VERSION));
    return words.length > 1 && !target ? 1 : 0;
  }
  const found = findCommand(words);
  if (!found) {
    const near = closest(words.slice(0, 2).join(' ')) ?? closest(words[0]!);
    io.err(`helix-loop: no command "${words.join(' ')}".${near ? ` Did you mean \`helix-loop ${near}\`?` : ''} Run \`helix-loop --help\` for the list.`);
    return 1;
  }
  const { command, rest } = found;
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...rest, ...flags],
      allowPositionals: true,
      strict: true,
      options: { ...Object.fromEntries(Object.entries({ ...GLOBAL_OPTIONS, ...command.options }).map(([n, o]) => [n, { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }])) },
    }) as { values: Values; positionals: string[] };
  } catch (e) {
    io.err(`helix-loop ${command.name}: ${(e as Error).message.replace(/^.*?: /, '')}. Run \`helix-loop ${command.name} --help\`.`);
    return 1;
  }
  if (parsed.values.help) return io.out(commandHelp(command)), 0;
  if (parsed.values.version) return io.out(VERSION), 0;
  const required = (command.args ?? []).filter((a) => !a.optional).length;
  const tooMany = !(command.args ?? []).some((a) => a.variadic) && parsed.positionals.length > (command.args ?? []).length;
  // "task hand-bak T-1" matched "task": a mistyped subcommand, said as one.
  if (tooMany && rest[0] && !rest[0].startsWith('-') && COMMANDS.some((c) => c.name.startsWith(`${command.name} `))) {
    const near = closest(`${command.name} ${rest[0]}`);
    io.err(`helix-loop: no command "${command.name} ${rest[0]}".${near ? ` Did you mean \`helix-loop ${near}\`?` : ''} Run \`helix-loop --help\` for the list.`);
    return 1;
  }
  if (parsed.positionals.length < required || tooMany) {
    io.err(`helix-loop ${command.name}: expected ${(command.args ?? []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(' ') || 'no arguments'}. Run \`helix-loop ${command.name} --help\`.`);
    return 1;
  }
  try {
    const root = command.project === false ? (typeof parsed.values.root === 'string' ? parsed.values.root : '') : projectRoot(typeof parsed.values.root === 'string' ? parsed.values.root : undefined);
    const ctx: Context = {
      root,
      args: parsed.positionals,
      opts: parsed.values,
      json: parsed.values.json === true,
      out: io.out,
      err: io.err,
      interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    };
    return (await command.run(ctx)) ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return e.code;
    }
    if (e instanceof NoProjectError) {
      io.err(e.message);
      return 2;
    }
    io.err(`helix-loop ${command.name}: ${(e as Error).message}`);
    if (process.env.HELIX_DEBUG) io.err((e as Error).stack ?? '');
    return 1;
  }
}
