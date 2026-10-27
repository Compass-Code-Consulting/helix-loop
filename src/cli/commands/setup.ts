import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { asset, configPath, findProject, HELIX_DIR, loadConfig, PACKAGE_ROOT, paths } from '../../config.ts';
import { installSkill, packSkill, skillInfo } from '../../skill.ts';
import { writeIndex } from '../../spec/index.ts';
import { Asker } from '../ask.ts';
import { define, str, UsageError, type Context } from '../command.ts';
import { referenceMarkdown } from '../help.ts';
import { COMMANDS } from '../registry.ts';
import { migrateLegacy } from '../migrate.ts';

// Starting a project, installing the Helix skill, checking a machine, and the docs generator.

const which = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim() || undefined;
const gitName = () => spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout.trim() || undefined;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---- the skill ----

type SkillAgent = 'claude' | 'codex';
// Where each agent reads skills: its home folder (global), or the project's own (.claude/skills, .codex/skills).
function skillDir(agent: SkillAgent, scope: 'global' | 'project', project: string): string {
  if (scope === 'project') return join(project, agent === 'claude' ? '.claude' : '.codex', 'skills', 'helix');
  return agent === 'claude' ? join(homedir(), '.claude', 'skills', 'helix') : join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills', 'helix');
}

export async function installSkillInteractively(ctx: Context, preset: { scope?: 'global' | 'project'; agents?: SkillAgent[]; project?: string }): Promise<string[]> {
  const detected = (['claude', 'codex'] as const).filter((a) => which(a));
  let scope = preset.scope;
  let agents = preset.agents;
  let project = preset.project ?? findProject() ?? process.cwd();
  if ((!scope || !agents) && ctx.interactive) {
    const ask = new Asker();
    try {
      scope ??= await ask.choose<'global' | 'project'>('Install the Helix skill where?', [['global', 'Globally: every project on this machine can use it'], ['project', `In one project only (${relative(process.cwd(), project) || '.'})`]], 'global');
      if (scope === 'project') project = resolve(await ask.text('Which project folder', project));
      agents ??= await ask.choose<'both' | SkillAgent>(
        'For which agents?',
        [['both', 'Claude Code and Codex'], ['claude', 'Claude Code only'], ['codex', 'Codex only']],
        detected.length === 1 ? detected[0]! : 'both',
      ).then((a) => (a === 'both' ? ['claude', 'codex'] : [a]));
    } finally {
      ask.close();
    }
  }
  scope ??= 'global';
  agents ??= detected.length ? [...detected] : ['claude', 'codex'];
  const dirs = agents.map((a) => skillDir(a, scope, project));
  for (const d of dirs) installSkill(PACKAGE_ROOT, d);
  return dirs;
}

const skillInstall = define({
  name: 'skill install',
  group: 'Start a project',
  summary: 'Install the Helix skill for Claude Code and Codex, globally or into one project',
  description: `The Helix skill teaches Claude Code and Codex to write a Helix Spec and a Helix TaskSet (/helix spec, /helix harden, /helix taskset, /helix validate), offline.
Without options it asks where to install it: globally (~/.claude/skills/helix, ~/.codex/skills/helix) or into one project (<project>/.claude/skills/helix, <project>/.codex/skills/helix), and for which agents.
Installing again updates it in place.`,
  project: false,
  options: {
    global: { type: 'boolean', description: 'Install it for every project on this machine' },
    project: { type: 'string', value: 'dir', description: 'Install it into this project folder only' },
    agent: { type: 'string', value: 'claude|codex|both', description: 'The agents to install it for (default: those installed here)' },
    to: { type: 'string', value: 'dir', description: 'Install it into exactly this folder instead' },
  },
  examples: [
    ['helix-loop skill install', 'Ask where, then install'],
    ['helix-loop skill install --global --agent both', 'Install it for Claude Code and Codex, everywhere'],
    ['helix-loop skill install --project .', 'Install it into this project only'],
  ],
  async run(ctx) {
    const { opts, out } = ctx;
    const to = str(opts, 'to');
    if (to) {
      const dir = resolve(to.replace(/^~(?=\/|$)/, homedir()));
      out(`Installed the Helix skill (${installSkill(PACKAGE_ROOT, dir).files.length} files) in ${dir}`);
      return;
    }
    const agent = str(opts, 'agent');
    if (agent && !['claude', 'codex', 'both'].includes(agent)) throw new UsageError('--agent is claude, codex or both.');
    const agents = agent === 'both' ? (['claude', 'codex'] as SkillAgent[]) : agent ? [agent as SkillAgent] : undefined;
    const projectDir = str(opts, 'project');
    if (opts.global && projectDir) throw new UsageError('Choose --global or --project, not both.');
    const dirs = await installSkillInteractively(ctx, { scope: opts.global ? 'global' : projectDir ? 'project' : undefined, agents, project: projectDir ? resolve(projectDir) : undefined });
    const v = skillInfo(PACKAGE_ROOT).version;
    for (const d of dirs) out(`Installed the Helix skill v${v} in ${d.replace(homedir(), '~')}`);
    out('In Claude Code or Codex, ask for /helix spec to write a spec, then /helix taskset to plan it.');
  },
});

const skillPack = define({
  name: 'skill pack',
  group: 'Start a project',
  summary: 'Build helix-skill.zip, to upload the skill where a folder can\'t go (claude.ai, a team)',
  project: false,
  args: [{ name: 'file', description: 'Where to write it (default: ./helix-skill.zip)', optional: true }],
  async run({ args, out }) {
    const r = await packSkill(PACKAGE_ROOT, resolve(args[0] ?? 'helix-skill.zip'));
    out(`Wrote ${r.file}: ${r.files.length} files, ${Math.round(r.bytes / 1024)} KB`);
  },
});

const skillShow = define({
  name: 'skill',
  group: 'Start a project',
  summary: 'Show the Helix skill: its version, its files, and where it is installed',
  project: false,
  json: true,
  run({ json, out }) {
    const info = skillInfo(PACKAGE_ROOT);
    const project = findProject();
    const places = [
      ...(['claude', 'codex'] as const).map((a) => skillDir(a, 'global', '')),
      ...(project ? (['claude', 'codex'] as const).map((a) => skillDir(a, 'project', project)) : []),
    ].map((d) => ({ dir: d, installed: existsSync(join(d, 'SKILL.md')), version: existsSync(join(d, 'SKILL.md')) ? /version:\s*["']?([^"'\s]+)/.exec(readFileSync(join(d, 'SKILL.md'), 'utf8'))?.[1] : undefined }));
    if (json) return out(JSON.stringify({ ...info, source: asset('skill'), places }, null, 2));
    out(`The Helix skill v${info.version}: ${info.files.length} files, from ${asset('skill')}`);
    for (const p of places) out(`  ${p.installed ? `✓ v${p.version ?? '?'}` : '·     '}  ${p.dir.replace(homedir(), '~')}`);
    if (!places.some((p) => p.installed)) out('Not installed anywhere yet: `helix-loop skill install`.');
  },
});

// ---- starting a project ----

const REPO_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const init = define({
  name: 'init',
  group: 'Start a project',
  summary: 'Start a Helix Loop project in this folder: the .helix/ folder, its config and its repos',
  description: `Asks for the product's name, who steers it, its time zone, the repositories to build and their gate commands, and the agents to use, then writes .helix/: config.yaml, the build prompt, and folders for the spec and the TaskSet.
Each repository is cloned into .helix/repos/<name>, or started empty for the loop to build from scratch.
It offers to install the Helix skill too. Everything it asks has an option, for scripts; --yes takes the defaults.`,
  project: false,
  options: {
    name: { type: 'string', value: 'name', description: "The product's name (default: this folder's)" },
    owner: { type: 'string', value: 'name', description: 'Who steers the loop and does its human tasks (default: your git name)' },
    timezone: { type: 'string', value: 'zone', description: 'The time zone dates are written in, as America/Chicago (default: this machine\'s)' },
    repo: { type: 'string', value: 'name[=url]', multiple: true, description: 'A repository to build: its name, and a git URL or path to clone, or nothing to start it empty. Repeat for each.' },
    gate: { type: 'string', value: 'command', description: 'The command that fully checks a repo before a merge (default: pnpm run gate)' },
    agents: { type: 'string', value: 'list', description: 'The agents to build with: claude, codex or both (default: those installed)' },
    spec: { type: 'string', value: 'file', description: 'A spec to start from, copied into .helix/spec/' },
    skill: { type: 'string', value: 'global|project|none', description: 'Install the Helix skill too, and where' },
    yes: { type: 'boolean', short: 'y', description: 'Take the defaults instead of asking' },
  },
  examples: [
    ['helix-loop init', 'Answer a few questions and start'],
    ['helix-loop init --name Acme --repo acme-app=git@github.com:acme/app.git --repo acme-site --yes', 'Start without questions: one repo cloned, one started empty'],
  ],
  async run(ctx) {
    const { opts, out } = ctx;
    const root = resolve(str(opts, 'root') ?? process.cwd());
    if (existsSync(configPath(root))) throw new UsageError(`${root} is a Helix Loop project already (${HELIX_DIR}/config.yaml). \`helix-loop doctor\` checks it.`);
    const asking = ctx.interactive && !opts.yes;
    const ask = asking ? new Asker() : undefined;
    try {
      if (asking) out(`Starting a Helix Loop project in ${root}.\n`);
      const name = str(opts, 'name') ?? (ask ? await ask.text("The product's name", basename(root)) : basename(root));
      const owner = str(opts, 'owner') ?? (ask ? await ask.text('Who steers the loop and does its human tasks', gitName() ?? userInfo().username) : (gitName() ?? userInfo().username));
      const timezone = str(opts, 'timezone') ?? (ask ? await ask.text('Time zone for dates', SYSTEM_ZONE) : SYSTEM_ZONE);
      if (!Intl.supportedValuesOf('timeZone').includes(timezone) && timezone !== 'UTC') throw new UsageError(`${timezone} is not a time zone; use a name like America/Chicago.`);
      const gate = str(opts, 'gate') ?? 'pnpm run gate';
      let repos: { name: string; from?: string; gate: string }[] = ((opts.repo as string[] | undefined) ?? []).map((r) => {
        const [n, ...from] = r.split('=');
        return { name: n!.trim(), from: from.join('=').trim() || undefined, gate };
      });
      if (!repos.length && ask) {
        out('\nThe repositories the loop builds, one lane each. Leave the name empty when you have listed them all.');
        for (;;) {
          const n = await ask.text(`Repository ${repos.length + 1} name`, repos.length ? '' : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-app`);
          if (!n) break;
          const from = await ask.text(`  Clone ${n} from (a git URL or path; empty to start it empty)`);
          const g = await ask.text(`  The command that fully checks ${n}`, gate);
          repos.push({ name: n, from: from || undefined, gate: g });
        }
      }
      if (!repos.length) throw new UsageError('Name at least one repository to build: --repo <name>[=<git url or path>].');
      const bad = repos.find((r) => !REPO_NAME.test(r.name));
      if (bad) throw new UsageError(`"${bad.name}" can't be a repo name: lowercase letters, digits, dots, dashes and underscores.`);
      const installed = (['claude', 'codex'] as const).filter((a) => which(a));
      const agentsOpt = str(opts, 'agents');
      const agents = agentsOpt ? (agentsOpt === 'both' ? ['claude', 'codex'] : agentsOpt.split(',').map((a) => a.trim())) : ask ? await ask.choose('Build with', [['both', 'Claude Code and Codex'], ['claude', 'Claude Code only'], ['codex', 'Codex only']], installed.length === 1 ? installed[0]! : 'both').then((a) => (a === 'both' ? ['claude', 'codex'] : [a])) : installed.length ? [...installed] : ['claude', 'codex'];
      if (agents.some((a) => a !== 'claude' && a !== 'codex')) throw new UsageError('--agents is claude, codex or both.');
      const spec = str(opts, 'spec') ?? (ask ? await ask.text('A spec to start from (a path; empty to write one with the Helix skill)') : undefined);
      if (spec && !existsSync(spec)) throw new UsageError(`No spec at ${spec}.`);
      const skill = str(opts, 'skill') ?? (ask ? await ask.choose('Install the Helix skill, which writes the spec and the TaskSet with you?', [['global', 'Yes, for every project'], ['project', 'Yes, for this project only'], ['none', 'Not now']], 'global') : 'none');

      // .helix/: the config from the template, the build prompt, and the folders the loop reads.
      const p = paths(root);
      for (const d of [p.specSections, p.tasks, p.human, p.prompts, p.helix, p.runs, p.repos]) mkdirSync(d, { recursive: true });
      const repoLines = repos.map((r) => `  ${r.name}: { gate: ${JSON.stringify(r.gate)}, prepare: "test ! -f pnpm-lock.yaml || pnpm install --frozen-lockfile --prefer-offline" }`).join('\n');
      writeFileSync(
        configPath(root),
        readFileSync(asset('templates', 'config.yaml'), 'utf8')
          .replace('{{NAME}}', JSON.stringify(name))
          .replace('{{OWNER}}', JSON.stringify(owner))
          .replace('{{TIMEZONE}}', timezone)
          .replace('{{REPOS}}', repoLines)
          .replace('{{CLAUDE}}', String(agents.includes('claude')))
          .replace('{{CODEX}}', String(agents.includes('codex'))),
      );
      cpSync(asset('templates', 'prompts', 'build.md'), join(p.prompts, 'build.md'));
      cpSync(asset('templates', 'gitignore'), join(p.home, '.gitignore'));
      loadConfig(root); // the config written must load, or init has a bug
      out('');
      for (const r of repos) {
        const dir = join(p.repos, r.name);
        if (r.from) {
          out(`Cloning ${r.name} from ${r.from}…`);
          execFileSync('git', ['clone', '-q', r.from, dir], { stdio: 'inherit' });
        } else {
          mkdirSync(dir, { recursive: true });
          execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
          writeFileSync(join(dir, 'README.md'), `# ${r.name}\n\nBuilt by Helix Loop from ${name}'s spec.\n`);
          execFileSync('git', ['add', '-A'], { cwd: dir });
          execFileSync('git', ['-c', 'user.name=Helix Loop', '-c', 'user.email=helix-loop@localhost', 'commit', '-q', '-m', 'Start'], { cwd: dir });
          out(`Started ${r.name} empty, on main.`);
        }
      }
      if (spec) {
        cpSync(spec, join(p.home, 'spec', basename(spec)));
        const i = writeIndex(paths(root).spec, p.specSections, p.specIndex);
        out(`Copied the spec in and indexed it: v${i.version}, ${Object.keys(i.sections).length} sections, ${Object.keys(i.reqs).length} requirements.`);
      }
      if (skill !== 'none') {
        const dirs = await installSkillInteractively({ ...ctx, interactive: false }, { scope: skill === 'project' ? 'project' : 'global', project: root });
        for (const d of dirs) out(`Installed the Helix skill in ${d.replace(homedir(), '~')}`);
      }
      out(`\nStarted ${name} in ${relative(process.cwd(), p.home) || HELIX_DIR}/. Next:`);
      if (!spec) out('  1. Write the spec with the Helix skill: in Claude Code or Codex here, ask for /helix spec. It goes in .helix/spec/.');
      out(`  ${spec ? 1 : 2}. Plan it: /helix taskset writes the TaskSet; \`helix-loop taskset import <folder> --apply\` brings it in.`);
      out(`  ${spec ? 2 : 3}. Check everything: \`helix-loop doctor\`, then \`helix-loop validate\`.`);
      out(`  ${spec ? 3 : 4}. Watch it work: \`helix-loop app --open\`, then \`helix-loop run\`.`);
      out('Commit .helix/ with the project: the config, spec and TaskSet are its source; runs, repos and worktrees are ignored.');
    } finally {
      ask?.close();
    }
  },
});

// ---- checking a machine and a project ----

const doctor = define({
  name: 'doctor',
  group: 'Start a project',
  summary: 'Check this machine and the project: Node, git, the agents, the config, the repos, the plan',
  project: false,
  run({ opts, out }) {
    let bad = 0;
    const line = (ok: boolean | 'warn', what: string, fix?: string) => {
      if (ok !== true) bad += ok === false ? 1 : 0;
      out(`${ok === true ? '✓' : ok === 'warn' ? '!' : '✗'} ${what}${ok !== true && fix ? `\n    ${fix}` : ''}`);
    };
    const major = Number(process.versions.node.split('.')[0]);
    line(major >= 26, `Node ${process.versions.node}`, 'Helix Loop needs Node 26 or later: https://nodejs.org');
    line(!!which('git'), 'git', 'Install git.');
    for (const a of ['claude', 'codex'] as const) {
      const at = which(a);
      const v = at ? spawnSync(a, ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim().split('\n')[0] : undefined;
      line(at ? true : 'warn', at ? `${a === 'claude' ? 'Claude Code' : 'Codex'} ${v ?? ''}`.trim() : `${a === 'claude' ? 'Claude Code' : 'Codex'} is not installed`, a === 'claude' ? 'brew install --cask claude-code' : 'npm install -g @openai/codex');
    }
    const root = str(opts, 'root') ?? findProject();
    if (!root) {
      out('\nNot in a Helix Loop project here: `helix-loop init` starts one.');
      return bad ? 1 : 0;
    }
    out(`\nProject: ${root}`);
    let config;
    try {
      config = loadConfig(root);
      line(true, `config: ${config.project?.name ?? basename(root)}, ${Object.keys(config.repos).length} repos`);
    } catch (e) {
      line(false, `config: ${(e as Error).message}`, `Fix ${relative(process.cwd(), configPath(root))}.`);
      return 1;
    }
    for (const a of ['claude', 'codex'] as const) if (config.agents[a].enabled && !which(config.agents[a].command)) line(false, `${a} is enabled but \`${config.agents[a].command}\` isn't on the PATH`, `Install it, or set agents.${a}.enabled: false.`);
    const p = paths(root);
    for (const r of Object.keys(config.repos)) {
      const dir = join(p.repos, r);
      const head = existsSync(join(dir, '.git')) ? spawnSync('git', ['rev-parse', '--verify', '-q', 'main'], { cwd: dir, encoding: 'utf8' }).stdout.trim() : '';
      line(!!head, `repo ${r}${head ? ` (main at ${head.slice(0, 7)})` : ''}`, existsSync(dir) ? `${dir} has no main branch.` : `Clone it: git clone <url> ${relative(process.cwd(), dir)}`);
    }
    line(existsSync(p.spec) ? (existsSync(p.specIndex) ? true : false) : 'warn', existsSync(p.spec) ? `spec: ${basename(p.spec)}` : 'no spec yet', existsSync(p.spec) ? 'Index it: `helix-loop spec index`.' : 'Write one with the Helix skill (/helix spec), into .helix/spec/.');
    line(existsSync(join(p.prompts, 'build.md')), 'build prompt', `Copy ${asset('templates', 'prompts', 'build.md')} to ${relative(process.cwd(), join(p.prompts, 'build.md'))}.`);
    out(bad ? `\n${bad} problem${bad === 1 ? '' : 's'}.` : '\nReady. `helix-loop validate` checks the plan itself.');
    return bad ? 1 : 0;
  },
});

const migrate = define({
  name: 'migrate',
  group: 'Start a project',
  summary: 'Move a control plane from before .helix/ (spec/, plan/, harness/config.yaml, runs/) into .helix/',
  description: `For a project that ran Helix Loop from inside it, before the tool stood alone: moves the spec, the TaskSet, the build prompt, the config and Helix's files into .helix/ with git mv, and the loop's runs, repos and worktrees after them (repairing the worktrees' links).
The loop must be stopped. Without --apply it only says what it would do.`,
  options: {
    apply: { type: 'boolean', description: 'Do it' },
    name: { type: 'string', value: 'name', description: "The product's name, for the config's new project block" },
    owner: { type: 'string', value: 'name', description: 'Who steers the loop, for the project block' },
    timezone: { type: 'string', value: 'zone', description: 'The time zone, for the project block' },
    'env-prefix': { type: 'string', value: 'PREFIX', description: 'The prefix the product\'s scripts read the loop\'s variables under (<PREFIX>_GATE_ID)' },
  },
  project: false,
  async run({ opts, out }) {
    const root = resolve(str(opts, 'root') ?? process.cwd());
    const r = await migrateLegacy(root, { apply: opts.apply === true, project: { name: str(opts, 'name'), owner: str(opts, 'owner'), timezone: str(opts, 'timezone') }, envPrefix: str(opts, 'env-prefix') }, out);
    return r ? 0 : 1;
  },
});

const docs = define({
  name: 'docs',
  group: 'Start a project',
  summary: 'Write docs/cli.md from the commands (for the tool\'s own repository)',
  hidden: true,
  project: false,
  options: { check: { type: 'boolean', description: 'Only check docs/cli.md is up to date' } },
  run({ opts, out, err }) {
    const file = asset('docs', 'cli.md');
    const text = referenceMarkdown(COMMANDS);
    if (opts.check) {
      const same = existsSync(file) && readFileSync(file, 'utf8') === text;
      if (!same) err('docs/cli.md is out of date: run `helix-loop docs`.');
      return same ? 0 : 1;
    }
    mkdirSync(asset('docs'), { recursive: true });
    writeFileSync(file, text);
    out(file);
  },
});

export const SETUP_COMMANDS = [init, doctor, skillInstall, skillShow, skillPack, migrate, docs];
