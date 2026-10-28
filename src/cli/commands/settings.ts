import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROLS, GROUPS, getValue, type ChangeSet, type Control } from '../../app/config.ts';
import { DEFAULT_FEEDBACK, FEEDBACK_LABELS, feedbackRule } from '../../app/hitl.ts';
import { listPrompts, promptsDir, readPrompt, resetPrompt, savePrompt } from '../../app/prompts.ts';
import { FEEDBACK_KINDS, loadConfig, paths, type Config } from '../../config.ts';
import { loadPlan } from '../../plan/store.ts';
import { AGENTS } from '../../types.ts';
import * as ops from '../../ops/index.ts';
import { withCli } from '../../ops/actor.ts';
import { define, str, UsageError } from '../command.ts';
import { confirm, fit, json, parseWord, plural, table, undoHint, usd, YES } from '../output.ts';

// The loop's settings, as the app's Settings shows them: the config values it may change (a change set, written
// with the file's comments kept, checked as the loop loads it, and committed), where builder feedback goes, the
// secrets builders need, and Helix's prompts.

// A value as the app shows it: percentages and kilobytes in their units, lists in commas, models with their effort.
function shown(c: Control | undefined, v: unknown): string {
  if (v === undefined || v === null) return '(not set)';
  if (Array.isArray(v)) return v.join(', ') || '(none)';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'object') {
    const m = v as { model?: string; effort?: string };
    return m.model ? `${m.model} · ${m.effort}` : JSON.stringify(v);
  }
  if (c?.type === 'usd') return usd(Number(v));
  return c?.unit ? `${v}${c.unit === '%' ? '%' : ` ${c.unit}`}` : String(v);
}

// A value as a command line gives it back: lists in commas, model:effort, default for a setting not set.
function word(v: unknown): string {
  if (v === undefined || v === null) return 'default';
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'object') {
    const m = v as { model?: string; effort?: string };
    return m.model ? `${m.model}:${m.effort}` : JSON.stringify(v);
  }
  return String(v);
}

// Any dotted path into the config, for the settings the app keeps outside the controls (pilot, feedback, helix).
const at = (config: Config, key: string) => key.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], config);
const valueOf = (config: Config, key: string) => {
  const c = CONTROLS.find((x) => x.key === key);
  return c ? getValue(config, c) : at(config, key);
};

// A command line's value as the control takes it: numbers, on and off, lists in commas, model:effort.
function typed(key: string, raw: string): unknown {
  const c = CONTROLS.find((x) => x.key === key);
  if (!c) return parseWord(raw);
  switch (c.type) {
    case 'int':
    case 'usd':
      return Number(raw.replace(/^\$/, ''));
    case 'bool':
      if (/^(on|true|yes)$/i.test(raw)) return true;
      if (/^(off|false|no)$/i.test(raw)) return false;
      throw new UsageError(`${key} is on or off, not ${raw}.`);
    case 'list':
      return raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',').map((s) => s.trim()).filter(Boolean);
    case 'model': {
      const [model, effort] = raw.split(/[:\s]+/);
      return { model, effort };
    }
    default:
      return raw;
  }
}

// key=value pairs, or one key and its value.
function changeSet(args: string[]): ChangeSet[] {
  if (args.length === 2 && !args[0]!.includes('=')) return [{ key: args[0]!, value: typed(args[0]!, args[1]!) }];
  return args.map((a) => {
    const i = a.indexOf('=');
    if (i < 1) throw new UsageError(`Give each setting as key=value, like limits.max_attempts=4; not ${a}.`);
    const key = a.slice(0, i);
    return { key, value: typed(key, a.slice(i + 1)) };
  });
}

const config = define({
  name: 'config',
  group: 'Settings',
  summary: 'The settings the app offers: each key, its value, and what it does',
  description: `Lists the loop's settings that Settings › Loop controls offers, by group, with their values in the units the app uses.
Change them with \`helix-loop config set\`; the loop reads them at the start of its next round.`,
  json: true,
  run(ctx) {
    const c = loadConfig(ctx.root);
    if (ctx.json) return json(ctx, CONTROLS.map((x) => ({ ...x, value: getValue(c, x) })));
    for (const g of GROUPS) {
      const mine = CONTROLS.filter((x) => x.group === g.id);
      if (!mine.length) continue;
      ctx.out(g.title);
      for (const l of table(mine.map((x) => [`  ${x.key}`, fit(shown(x, getValue(c, x)), 26), `${x.label}: ${x.note}`]))) ctx.out(l);
      ctx.out('');
    }
    ctx.out('Change: helix-loop config set <key>=<value>...');
  },
});

const get = define({
  name: 'config get',
  group: 'Settings',
  summary: "One setting's value",
  args: [{ name: 'key', description: 'The setting, as `helix-loop config` lists it, or a path like pilot.mode' }],
  json: true,
  run(ctx) {
    const key = ctx.args[0]!;
    const v = valueOf(loadConfig(ctx.root), key);
    // Pilot mode, feedback and Helix's settings fall back to their defaults when the config leaves them out.
    const optional = /^(pilot|feedback|helix)\./.test(key);
    if (v === undefined && !optional && !CONTROLS.some((x) => x.key === key)) throw new UsageError(`No setting ${key}: \`helix-loop config\` lists them.`);
    if (ctx.json) return json(ctx, { key, value: v ?? null });
    ctx.out(v === undefined ? `(not set: ${key} takes its default; \`helix-loop pilot\`, \`feedback\` and \`monitor\` show what is in force)` : word(v));
  },
});

const set = define({
  name: 'config set',
  group: 'Settings',
  summary: 'Change settings as one checked commit, the config\'s comments kept',
  description: `Writes each key=value into .helix/config.yaml in place, keeping its comments, loads it as the loop would to check it, and commits it as one change.
Values take the units \`helix-loop config\` shows: 80 for 80%, on or off, lists in commas, model:effort.
--dry-run tries the change set in a fresh dry run of the plan instead (fake agents, nothing real touched).`,
  args: [{ name: 'key=value', description: 'The settings to change; or one key and its value', variadic: true }],
  options: { 'dry-run': { type: 'boolean', description: 'Try it in a dry run instead' }, ...YES },
  examples: [
    ['helix-loop config set limits.max_attempts=4 agents.codex.slots=3', 'Two settings, one commit'],
    ['helix-loop config set agents.codex.models.build gpt-6.1-sol:xhigh', 'One setting, as key and value'],
    ['helix-loop config set limits.gate_timeout_minutes=40 --dry-run', 'Try it first'],
  ],
  async run(ctx) {
    const { root } = ctx;
    const changes = changeSet(ctx.args);
    ops.checkConfigChanges(root, changes);
    if (ctx.opts['dry-run']) {
      const r = await ops.startLoop(root, 'dry', { agents: [...AGENTS], configChanges: changes });
      ctx.out(`A dry run with ${changes.map((c) => c.key).join(', ')} changed started (pid ${r.pid}); its output goes to .helix/${r.log}.`);
      return;
    }
    const before = loadConfig(root);
    const lines = changes.map((c) => `  ${c.key}: ${shown(CONTROLS.find((x) => x.key === c.key), valueOf(before, c.key))} → ${shown(CONTROLS.find((x) => x.key === c.key), c.value)}`);
    await confirm(ctx, `Apply ${plural(changes.length, 'change')} to .helix/config.yaml?`, lines);
    await ops.applyConfig(root, changes, withCli(root));
    for (const l of lines) ctx.out(l);
    const back = changes.map((c) => {
      const w = word(valueOf(before, c.key));
      return `${c.key}=${/[\s'"]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w}`;
    });
    ctx.out(`Applied as one commit; the loop reads it on its next round. Set it back: helix-loop config set ${back.join(' ')}`);
  },
});

const check = define({
  name: 'config check',
  group: 'Settings',
  summary: 'Check the config loads as the loop loads it, with a change set if given',
  args: [{ name: 'key=value', description: 'Settings to check as if changed', optional: true, variadic: true }],
  run(ctx) {
    const changes = ctx.args.length ? changeSet(ctx.args) : [];
    ops.checkConfigChanges(ctx.root, changes);
    ctx.out(changes.length ? `The config loads with ${changes.map((c) => c.key).join(', ')} changed. Apply: helix-loop config set ${ctx.args.join(' ')}` : '.helix/config.yaml loads as the loop loads it.');
  },
});

const feedback = define({
  name: 'feedback',
  group: 'Settings',
  summary: "Where each kind of builder feedback goes: your inbox, Helix, or nowhere, and when",
  description: `Builders report what stops them (a spec question, a missing secret, a flaky test); the loop records gate failures.
Each kind's rule says where it goes (inbox, helix, off), after how many (first, task:N times on one task, tasks:N on N tasks), and whether the pass stops at once (pause) or a notification goes out (notify).
Rules can differ per lane.`,
  json: true,
  run(ctx) {
    const c = loadConfig(ctx.root);
    const rules = FEEDBACK_KINDS.map((k) => ({ kind: k, ...FEEDBACK_LABELS[k], rule: feedbackRule(c, k), preset: DEFAULT_FEEDBACK[k] }));
    const lanes = Object.entries(c.feedback?.lanes ?? {}).map(([lane, r]) => ({ lane, rules: r }));
    if (ctx.json) return json(ctx, { kinds: rules, lanes });
    const yes = (b: boolean) => (b ? 'yes' : '');
    for (const l of table([['KIND', 'SEND TO', 'AFTER', 'PAUSE', 'NOTIFY', 'WHAT IT MEANS'], ...rules.map((r) => [r.kind, r.rule.send_to, r.rule.after, yes(r.rule.pause), yes(r.rule.notify), r.means])])) ctx.out(l);
    for (const l of lanes) {
      ctx.out('');
      ctx.out(`In ${l.lane}: ${Object.entries(l.rules ?? {}).map(([k, r]) => `${k} ${Object.entries(r ?? {}).map(([f, v]) => `${f}=${String(v)}`).join(' ')}`).join('; ')}`);
    }
    ctx.out('');
    ctx.out('Change one: helix-loop feedback set <kind> <send_to|after|pause|notify> <value> [--lane repo]');
  },
});

const feedbackSet = define({
  name: 'feedback set',
  group: 'Settings',
  summary: "Change one field of a kind of feedback's rule, for every lane or one",
  args: [
    { name: 'kind', description: FEEDBACK_KINDS.join(', ') },
    { name: 'field', description: 'send_to, after, pause or notify' },
    { name: 'value', description: 'inbox, helix or off; first, task:N or tasks:N; on or off' },
  ],
  options: { lane: { type: 'string', value: 'repo', description: 'Only for this lane' } },
  examples: [['helix-loop feedback set flaky_test after tasks:3', 'Bring a flaky test once it hits three tasks']],
  async run(ctx) {
    const [kind, field, value] = ctx.args as [string, string, string];
    if (!(ops.FEEDBACK_FIELDS as readonly string[]).includes(field)) throw new UsageError(`The field is ${ops.FEEDBACK_FIELDS.join(', ')}.`);
    const v = field === 'pause' || field === 'notify' ? parseWord(value) : value;
    if ((field === 'pause' || field === 'notify') && typeof v !== 'boolean') throw new UsageError(`${field} is on or off.`);
    await ops.setFeedback(ctx.root, kind, { [field]: v }, str(ctx.opts, 'lane'), withCli(ctx.root));
    ctx.out(`${kind}${str(ctx.opts, 'lane') ? ` in ${str(ctx.opts, 'lane')}` : ''}: ${field} is ${String(value)}.`);
  },
});

// A value typed without echo at a terminal, or read whole from standard input when it is piped.
async function readSecret(name: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(`${name} (typed or pasted; not shown): `);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let v = '';
    const end = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      fn();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return end(() => resolve(v));
        if (ch === '\u0003') return end(() => reject(new UsageError('Nothing saved.', 130)));
        if (ch === '\u007f' || ch === '\b') v = v.slice(0, -1);
        else v += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const secret = define({
  name: 'secret set',
  group: 'Settings',
  summary: 'Save a secret builders need, and hand back the tasks that stopped for it',
  description: `Reads the value from standard input without showing it (type or paste it, or pipe it in), and saves it where the app's "Add the secret" does: the macOS keychain as "Helix Loop: NAME", or with --github as a secret of that repo, through gh.
The value is never printed, logged or written to a file.
The tasks that stopped for it then go back to the loop, as one commit.`,
  args: [{ name: 'NAME', description: 'The secret\'s name, upper case: STRIPE_TEST_KEY' }],
  options: {
    github: { type: 'string', value: 'repo', description: 'Save it as a GitHub secret of this repo instead' },
    env: { type: 'string', value: 'name', description: 'With --github: a deployment environment, like production' },
    'hand-back': { type: 'string', value: 'ids', description: 'The tasks to hand back, comma-separated (by default those that stopped for it)' },
    ...YES,
  },
  examples: [
    ['helix-loop secret set STRIPE_TEST_KEY', 'Type it in; it goes to the keychain'],
    ['pbpaste | helix-loop secret set STRIPE_KEY --github acme-app --env production --yes', 'From the clipboard, to GitHub'],
  ],
  async run(ctx) {
    const { root } = ctx;
    const name = ctx.args[0]!;
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) throw new UsageError('A secret name is upper case, like STRIPE_TEST_KEY.');
    const github = str(ctx.opts, 'github');
    if (github) ops.repoArg(loadConfig(root), github);
    const inc = ops.incidentsNow(root).find((i) => i.key === `cred:${name}` && i.open);
    const plan = loadPlan(paths(root).tasks, paths(root).human);
    const tasks = str(ctx.opts, 'hand-back')?.split(',').map((s) => s.trim()).filter(Boolean) ?? (inc?.members.map((m) => m.task).filter((id) => ['needs_human', 'parked'].includes(plan.tasks.get(id)?.status ?? '')) ?? []);
    const where = github ? `as a GitHub secret of ${github}${str(ctx.opts, 'env') ? `, environment ${str(ctx.opts, 'env')}` : ''}, with gh secret set` : `in the macOS keychain, as "Helix Loop: ${name}"`;
    // GitHub is outward-facing: always confirmed. The keychain is asked about only at a terminal.
    if (github || process.stdin.isTTY) await confirm(ctx, `Save ${name} ${where}?`, tasks.length ? [`Then ${tasks.join(', ')} go${tasks.length === 1 ? 'es' : ''} back to the loop.`] : []);
    const value = await readSecret(name);
    const r = await ops.addSecret(root, { name, value, where: github ? 'github' : 'keychain', repo: github, env: str(ctx.opts, 'env'), tasks }, withCli(root));
    ctx.out(`Saved ${name} ${where}.${r.handed?.tasks.length ? ` Handed back ${r.handed.tasks.join(', ')}.${undoHint(r.handed.change)}` : ''}`);
  },
});

const prompts = define({
  name: 'prompts',
  group: 'Settings',
  summary: "Helix's prompts: one per role and pilot level, and whether you edited it",
  json: true,
  run(ctx) {
    const list = listPrompts(ctx.root);
    if (ctx.json) return json(ctx, list);
    for (const l of table(list.map((p) => [p.name, p.edited ? 'edited' : 'preset', p.text.split('\n').find((x) => x.trim() && !x.startsWith('#')) ?? '']))) ctx.out(l);
    ctx.out('');
    ctx.out('Show one: helix-loop prompt show <name> · edit it: helix-loop prompt edit <name>');
  },
});

const named = (root: string, name: string) => {
  const p = readPrompt(root, name);
  if (!p) throw new UsageError(`No prompt ${name}: \`helix-loop prompts\` lists them.`);
  return p;
};

const promptShow = define({
  name: 'prompt show',
  group: 'Settings',
  summary: 'Print one of Helix\'s prompts as it runs now',
  args: [{ name: 'name', description: 'The prompt, as `helix-loop prompts` lists it' }],
  json: true,
  run(ctx) {
    const p = named(ctx.root, ctx.args[0]!);
    if (ctx.json) return json(ctx, p);
    ctx.out(p.text);
  },
});

const promptEdit = define({
  name: 'prompt edit',
  group: 'Settings',
  summary: "Edit one of Helix's prompts in your editor; it wins until reset",
  description: `Opens the project's copy of the prompt (.helix/helix/prompts/<name>.local.md) in $VISUAL or $EDITOR, and commits it when you close the editor.
An edit the same as the preset goes back to the preset.
Prompts carry judgment only: what Helix may do is its tools' business, so no edit widens it.
--file takes the text from a file instead of an editor.`,
  args: [{ name: 'name', description: 'The prompt' }],
  options: { file: { type: 'string', value: 'path', description: 'Take the text from this file' } },
  async run(ctx) {
    const { root } = ctx;
    const name = ctx.args[0]!;
    const p = named(root, name);
    const local = join(promptsDir(root), `${name}.local.md`);
    let text: string;
    const from = str(ctx.opts, 'file');
    if (from) text = readFileSync(from, 'utf8');
    else {
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (!editor || !ctx.interactive) throw new UsageError('prompt edit opens $VISUAL or $EDITOR at a terminal; or pass --file with the new text.');
      mkdirSync(promptsDir(root), { recursive: true });
      if (!existsSync(local)) writeFileSync(local, `${p.text}\n`);
      const r = spawnSync(editor, [local], { stdio: 'inherit', shell: true });
      if (r.status !== 0) throw new UsageError(`${editor} exited with ${r.status}; nothing saved.`);
      text = readFileSync(local, 'utf8');
      if (!text.trim()) {
        writeFileSync(local, `${p.text}\n`);
        throw new UsageError(`The prompt can't be empty; it is as it was. To go back to the preset: helix-loop prompt reset ${name}`);
      }
    }
    if (text.trim() === p.text && !from) return ctx.out(`Unchanged: ${name} is as it was.`);
    const saved = await savePrompt(root, name, text, 'with helix-loop');
    ctx.out(saved.edited ? `Saved your ${name}; it runs from Helix's next turn. Back to the preset: helix-loop prompt reset ${name}` : `${name} is the preset again.`);
  },
});

const promptReset = define({
  name: 'prompt reset',
  group: 'Settings',
  summary: "Put one of Helix's prompts back to its preset",
  args: [{ name: 'name', description: 'The prompt' }],
  async run(ctx) {
    const p = named(ctx.root, ctx.args[0]!);
    if (!p.edited) return ctx.out(`Nothing changed: ${p.name} is the preset.`);
    await resetPrompt(ctx.root, p.name, 'with helix-loop');
    ctx.out(`${p.name} is the preset again.`);
  },
});

export const SETTINGS_COMMANDS = [config, get, set, check, feedback, feedbackSet, secret, prompts, promptShow, promptEdit, promptReset];
