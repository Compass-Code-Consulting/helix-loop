#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseArgs } from 'node:util';
import { claudeAdapter } from '../src/agents/claude.ts';
import { codexAdapter } from '../src/agents/codex.ts';
import { describePace, loadQuota, mapAgents, paceSlots } from '../src/agents/quota.ts';
import { systemClock } from '../src/clock.ts';
import { CONTROL_PLANE, loadConfig, paths, weeklyTargets } from '../src/config.ts';
import { meanPassHours, readLedger } from '../src/ledger.ts';
import { EXIT, runLoop } from '../src/loop.ts';
import { computeMap } from '../src/map/graph.ts';
import { renderDependencyMap } from '../src/map/render.ts';
import { macNotifier } from '../src/notify.ts';
import { startApp } from '../src/app/server.ts';
import { buildBoard } from '../src/app/board.ts';
import { boardInput } from '../src/app/views.ts';
import { applyToText } from '../src/app/config.ts';
import { diffTaskSet, initTaskSet, loadTaskSet, readTaskSetFile, tasksetFile, writeTaskSetFile } from '../src/app/taskset.ts';
import { commit } from '../src/app/actions.ts';
import { applyChanges } from '../src/app/fixes.ts';
import { installSkill, packSkill } from '../src/skill.ts';
import { homedir, tmpdir } from 'node:os';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { prepareDryRun } from '../src/dryrun.ts';
import { atomicWrite, loadPlan, writeTask } from '../src/plan/store.ts';
import { allSynthetic, checkStaging, loadDeferred, loadPlanners, resolveStaging } from '../src/plan/staging.ts';
import { renderHumanPlan, renderImplementationPlan } from '../src/plan/render.ts';
import { validateCoverage, validateGraph, validatePrompts, validateReleaseHolds, validateRepos, validateSchemas, validateState } from '../src/plan/validate.ts';
import { approveRelease, describeBase, pendingApprovals, releaseRepo, releaseSettings, unreleased } from '../src/release.ts';
import { loadIndex, writeIndex } from '../src/spec/index.ts';
import { AGENTS } from '../src/types.ts';
import { buildStats, formatStats } from '../src/stats.ts';
import { buildMetrics } from '../src/metrics/model.ts';
import { VERSION_EVERY, writeVersion } from '../src/metrics/archive.ts';
import { taskHistory } from '../src/metrics/render.ts';

const USAGE = `helix-loop <command>   (mushy-loop is its old name, kept as an alias)

  index                 regenerate spec/sections and spec/index.json from the spec
  sections [filter]     list the spec citation keys tasks can use, with their sizes in bytes
  stage-check <planner> check a planner's staged tasks in plan/staging/<planner>/ (planners run this)
  promote <planner>... [--dry-run]
                        resolve staged tasks (cap: dependencies included) into plan/tasks and plan/human;
                        --dry-run checks the merged plan (graph, coverage, prompt sizes) without writing
  render                write the Implementation Plan and Human Implementation Plan documents from plan data
  validate              check the plan: schema, dependency graph, requirement coverage, prompt sizes, state
  map                   regenerate the dependency map (plan/Mushy.LoopEngineering.DependencyMap.html)
  status                one screen: task counts, agents, mode, projected finish, held releases
  stats                 how the build has used each agent since the loop first started: working, gating, limited, idle
  metrics               write a version of the metrics page now (runs/metrics/): progress and its projection,
                        where the time goes, cost, what fails; the loop writes one every metrics_every_passes passes
  app [--port N]        Helix Loop, the control room: Home, the Map, Live, Helix, the metrics and Settings, on
                        http://127.0.0.1:<app.port>; it also serves the MCP endpoints for builders and Helix
  taskset init          write plan/taskset.yaml with one epic per (repo, feature, stage), and each task's epic
  taskset import <path> [--apply] [--dry-run]
                        check a TaskSet (a plan folder or a zip) and diff it against the running plan; --apply
                        writes it as one commit, --dry-run runs it in runs/dry-run/ instead
  skill pack [file]     build helix-skill.zip from skill/ and the plan's schemas
  skill install --to <dir>
                        install the Helix skill into an agent's skills folder
  run [--max-passes N] [--agents claude,codex] [--dry-run [--config-changes <file>] [--plan-changes <file>]]
                        run the loop; --agents picks this run's agents (overrides agents.*.enabled);
                        --dry-run runs it in runs/dry-run/ on a copy of the plan, with the fake CLIs, and
                        --config-changes and --plan-changes a change set or a fix applied to it (Try in dry run)
  release <repo>        release the repo's main now, with the loop's holds; says what lifts a hold
  approve-release <repo> <tag>
                        tag and push a release held for review (it changes release.review_paths), once its
                        diff is read

Exit codes of run: 0 all done · 10 only work that needs a person is left · 3 stopped · 1 harness error.
Exit codes of release: 0 released, or nothing new to release · 10 held until a person acts · 1 error.
Stop gracefully with: touch runs/STOP`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'max-passes': { type: 'string' }, root: { type: 'string' }, 'dry-run': { type: 'boolean' }, agents: { type: 'string' }, port: { type: 'string' }, 'config-changes': { type: 'string' }, 'plan-changes': { type: 'string' }, apply: { type: 'boolean' }, to: { type: 'string' } },
});
const root = values.root ?? CONTROL_PLANE;
const p = paths(root);
const command = positionals[0];

function validateAll(): number {
  const plan = loadPlan(p.tasks, p.human);
  const config = loadConfig(root);
  const index = loadIndex(p.specIndex);
  const problems = [
    ...validateSchemas(p.schema, p.tasks, p.human),
    ...validateGraph(plan),
    ...validateRepos(plan, config.repos),
    ...validateState(plan),
    ...validateReleaseHolds(plan, config.release.hold_until),
    ...validateCoverage(plan, index, p.syntheticReqs, loadDeferred(root)),
    ...validatePrompts(plan, index, p.specSections, readFileSync(join(p.prompts, 'build.md'), 'utf8'), config.limits.prompt_budget_bytes),
  ];
  for (const x of problems) console.log(`${x.id}: ${x.message}`);
  console.log(`${plan.tasks.size} tasks, ${plan.human.size} human tasks, ${problems.length} problems`);
  return problems.length ? 1 : 0;
}

function currentMap() {
  const config = loadConfig(root);
  const plan = loadPlan(p.tasks, p.human);
  const quota = loadQuota(p.agentsState, Date.now());
  return computeMap(plan, {
    now: Date.now(),
    passHours: meanPassHours(readLedger(p.ledger)),
    // What each agent holds, as the plan's claims say.
    agents: mapAgents(config, quota, [...plan.tasks.values()].flatMap((t) => (t.status === 'claimed' && t.claimed_by ? [{ agent: t.claimed_by, task: t.id }] : [])), Date.now()),
    mode: 'idle',
  });
}

async function main(): Promise<number> {
  switch (command) {
    case 'index': {
      const i = writeIndex(p.spec, p.specSections, p.specIndex);
      console.log(`spec v${i.version}: ${Object.keys(i.sections).length} sections, ${Object.keys(i.reqs).length} requirements`);
      return 0;
    }
    case 'validate':
      return validateAll();
    case 'sections': {
      const index = loadIndex(p.specIndex);
      const filter = (positionals[1] ?? '').toLowerCase();
      for (const s of Object.values(index.sections)) {
        if (filter && !s.key.toLowerCase().includes(filter)) continue;
        const text = readFileSync(join(p.specSections, s.file), 'utf8').split('\n').slice(s.startLine - 1, s.endLine).join('\n');
        console.log(`${String(Buffer.byteLength(text)).padStart(6)}  ${s.key}`);
      }
      return 0;
    }
    case 'stage-check': {
      const owner = positionals[1];
      if (!owner) {
        console.log('usage: mushy-loop stage-check <planner>');
        return 1;
      }
      const problems = checkStaging(root, owner);
      for (const x of problems) console.log(`${x.id}: ${x.message}`);
      console.log(problems.length ? `${problems.length} problems` : `${owner}: staging is clean`);
      return problems.length ? 1 : 0;
    }
    case 'promote': {
      const planners = loadPlanners(root);
      const owners = positionals.slice(1);
      if (!owners.length) {
        console.log('usage: mushy-loop promote <planner>...');
        return 1;
      }
      for (const o of owners) {
        if (!planners.has(o)) {
          console.log(`no planner ${o}`);
          return 1;
        }
      }
      const { plan: staged, synthetic, problems } = resolveStaging(root, owners);
      const current = loadPlan(p.tasks, p.human);
      for (const [id, t] of staged.tasks) {
        if (current.tasks.has(id)) problems.push({ id, message: 'already in plan/tasks; promotion never overwrites a live task' });
        current.tasks.set(id, t);
      }
      for (const [id, h] of staged.human) current.human.set(id, h);
      problems.push(...validateGraph(current));
      if (values['dry-run']) {
        const index = loadIndex(p.specIndex);
        const synth = join(root, 'runs', 'dry-run-synthetic.yaml');
        mkdirSync(join(root, 'runs'), { recursive: true });
        writeFileSync(synth, (existsSync(p.syntheticReqs) ? readFileSync(p.syntheticReqs, 'utf8') : '') + stringify(synthetic, { lineWidth: 0 }));
        problems.push(
          ...validateCoverage(current, index, synth, loadDeferred(root)),
          ...validatePrompts(current, index, p.specSections, readFileSync(join(p.prompts, 'build.md'), 'utf8'), loadConfig(root).limits.prompt_budget_bytes),
        );
        for (const x of problems) console.log(`${x.id}: ${x.message}`);
        const passes = [...current.tasks.values()].reduce((n, t) => n + t.estimate_passes, 0);
        console.log(`dry run: ${current.tasks.size} tasks (${passes} passes), ${current.human.size} human tasks, ${problems.length} problems`);
        return problems.length ? 1 : 0;
      }
      if (problems.length) {
        for (const x of problems.slice(0, 60)) console.log(`${x.id}: ${x.message}`);
        console.log(`${problems.length} problems; nothing promoted`);
        return 1;
      }
      for (const t of staged.tasks.values()) writeTask(p.tasks, t);
      mkdirSync(p.human, { recursive: true });
      for (const h of staged.human.values()) atomicWrite(join(p.human, `${h.id}.yaml`), stringify(h, { lineWidth: 0 }));
      if (synthetic.length) {
        const existing = existsSync(p.syntheticReqs) ? (readFileSync(p.syntheticReqs, 'utf8')) : '';
        const ids = new Set([...existing.matchAll(/id: ([A-Z]+-\d+[a-z]?)/g)].map((m) => m[1]));
        const fresh = synthetic.filter((s) => !ids.has(s.id));
        if (fresh.length) atomicWrite(p.syntheticReqs, existing + stringify(fresh, { lineWidth: 0 }));
      }
      console.log(`promoted ${staged.tasks.size} tasks and ${staged.human.size} human tasks from ${owners.join(', ')}`);
      return 0;
    }
    case 'map': {
      atomicWrite(p.map, renderDependencyMap(currentMap()));
      console.log(p.map);
      return 0;
    }
    case 'render': {
      const plan = loadPlan(p.tasks, p.human);
      const map = currentMap();
      const index = loadIndex(p.specIndex);
      const synthetic = allSynthetic(root).filter((s) => [...plan.tasks.values()].some((t) => t.reqs.includes(s.id)));
      const agentDoc = join(root, 'plan', 'Mushy.LoopEngineering.ImplementationPlan.md');
      const humanDoc = join(root, 'plan', 'Mushy.LoopEngineering.HumanImplementationPlan.md');
      const areas = [...loadPlanners(root).values()].map((x) => x.name);
      writeFileSync(agentDoc, renderImplementationPlan(plan, map, index, synthetic, areas));
      writeFileSync(humanDoc, renderHumanPlan(plan, map));
      atomicWrite(p.map, renderDependencyMap(map));
      console.log(`${agentDoc}\n${humanDoc}\n${p.map}`);
      return 0;
    }
    case 'metrics': {
      const plan = loadPlan(p.tasks, p.human);
      const v = writeVersion(p.metrics, buildMetrics({ events: readLedger(p.ledger), plan, now: Date.now(), history: taskHistory(root), targets: weeklyTargets(loadConfig(root)), timeZone: projectInfo(loadConfig(root)).timezone, product: projectInfo(loadConfig(root)).name }), loadConfig(root).metrics_every_passes ?? VERSION_EVERY);
      console.log(join(p.metrics, v.file));
      return 0;
    }
    case 'stats': {
      const holding = [...loadPlan(p.tasks, p.human).tasks.values()].filter((x) => x.status === 'claimed' && x.claimed_by).map((x) => x.claimed_by!);
      for (const line of formatStats(buildStats(readLedger(p.ledger), AGENTS, Date.now(), holding), projectInfo(loadConfig(root)).timezone)) console.log(line);
      return 0;
    }
    case 'status': {
      const m = currentMap();
      const t = m.totals;
      console.log(`tasks ${t.tasks}: ${t.done} done, ${t.ready} ready, ${t.claimed} claimed, ${t.needsHuman} need a person, ${t.parked} parked`);
      const config = loadConfig(root);
      const quota = loadQuota(p.agentsState, Date.now());
      for (const a of m.agents) {
        console.log(`${a.name} (${a.model}): ${a.state}${a.resetAt ? ` until ${a.resetAt}` : ''}`);
        const q = quota[a.name];
        const pace = paceSlots(q.usage, config.agents[a.name].slots, Date.now(), config.agents[a.name].weekly_target);
        const line = describePace(q.usage, pace, config.agents[a.name].weekly_target, Date.now());
        if (line) console.log(`  ${line} (read ${new Date(q.usage!.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`);
      }
      // The app's projection: code complete when the TaskSet shows it, and project complete with people's lead times.
      const plan = loadPlan(p.tasks, p.human);
      const board = buildBoard(boardInput(root, plan, readLedger(p.ledger), config, Date.now()));
      const day = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const finish = board.codeFinish !== undefined ? `code complete ${day(board.codeFinish)} · project complete ${day(board.finish)}` : `projected finish ${day(board.finish)}`;
      console.log(`critical path: ${m.criticalPath.length} nodes; ${finish}`);
      const human = plan.human;
      for (const [repo, step] of Object.entries(loadConfig(root).release.hold_until ?? {})) {
        const h = human.get(step!);
        if (h?.status !== 'done') console.log(`${repo}: releases held until ${step} is done (${h ? h.status : 'not in the plan'})`);
      }
      for (const { approval: a } of pendingApprovals(p.approvals)) {
        console.log(`${a.repo} ${a.tag} waits for approval: it changes ${a.paths.join(', ')} since ${describeBase(a.since)}`);
        console.log(`  review:  ${a.review}`);
        console.log(`  approve: ${a.approve}`);
      }
      return 0;
    }
    case 'approve-release': {
      const [, repo, tag] = positionals;
      const config = loadConfig(root);
      if (!repo || !tag || !(repo in config.repos)) {
        console.log('usage: mushy-loop approve-release <repo> <tag>   (mushy-loop status lists the releases waiting)');
        return 1;
      }
      try {
        const r = await approveRelease({ repo, dir: join(p.repos, repo), tag, approvals: p.approvals, ledger: p.ledger, push: config.push, now: Date.now() });
        const at = r.approval.commit.slice(0, 12);
        if (r.pushed === false) {
          console.log(`${repo} ${tag} is approved and tagged at ${at}, but the push failed. It is pushed again before the repo's next release, or now with: mushy-loop release ${repo}`);
          return 1;
        }
        console.log(`${repo} ${tag} is tagged at ${at}${r.pushed === true ? ' and pushed' : '; not pushed (push is off, or the repo has no origin)'}.`);
        return 0;
      } catch (e) {
        console.log((e as Error).message);
        return 1;
      }
    }
    case 'release': {
      // The same release as the loop's checkpoints and stage closes, with the same holds, cut now.
      const repo = positionals[1];
      const config = loadConfig(root);
      if (!repo || !(repo in config.repos)) {
        console.log(`usage: mushy-loop release <repo>   (${Object.keys(config.repos).join(', ')})`);
        return 1;
      }
      const plan = loadPlan(p.tasks, p.human);
      try {
        const r = await releaseRepo({
          ...releaseSettings(config, p, repo),
          human: plan.human,
          now: Date.now(),
          reason: 'Released by hand',
          tasks: unreleased(p.ledger, repo).map((id) => ({ id, title: plan.tasks.get(id)?.title ?? '' })),
        });
        if (r.retried) console.log(`${r.retried.pushed ? 'Pushed' : 'Could not push'} ${r.retried.tags.join(', ')} to origin; an earlier push had failed.`);
        if (r.kind === 'current') {
          console.log(`${repo}: main (${r.commit.slice(0, 12)}) is already released as ${r.tag}; nothing new to release.`);
          return r.retried?.pushed === false ? 1 : 0;
        }
        if (r.kind === 'held') {
          console.log(`${repo} is not released: held ${r.detail}.`);
          console.log(`To lift the hold: ${r.clears}.`);
          return 10;
        }
        const pushed = r.pushed === true ? ' and pushed' : r.pushed === false ? ', but the push failed; it is pushed again before the next release, or run this again' : '; not pushed (push is off, or the repo has no origin)';
        console.log(`${repo} ${r.tag} is tagged at ${r.commit.slice(0, 12)}${pushed}.`);
        return r.pushed === false ? 1 : 0;
      } catch (e) {
        console.log((e as Error).message);
        return 1;
      }
    }
    case 'taskset': {
      const sub = positionals[1];
      if (sub === 'init') {
        if (readTaskSetFile(root)) {
          console.log('plan/taskset.yaml exists already; edit it by hand to rename or merge epics');
          return EXIT.harnessError;
        }
        const plan = loadPlan(p.tasks, p.human);
        const { file, changed } = initTaskSet(root, plan);
        writeTaskSetFile(root, file);
        for (const t of changed) writeTask(p.tasks, t);
        const epics = Object.values(file.lanes).reduce((n, l) => n + Object.keys(l.epics).length, 0);
        console.log(`wrote plan/taskset.yaml: ${Object.keys(file.lanes).length} lanes, ${epics} epics; set the epic of ${changed.length} tasks`);
        console.log('rename and merge epics in plan/taskset.yaml as you like (keep each task\'s epic in step), then commit');
        return 0;
      }
      if (sub === 'import') return importTaskSet(positionals[2]);
      console.log(USAGE);
      return EXIT.harnessError;
    }
    case 'skill': {
      if (positionals[1] === 'pack') {
        const r = await packSkill(root, positionals[2] ?? join(p.runs, 'helix-skill.zip'));
        console.log(`wrote ${r.file}: ${r.files.length} files, ${Math.round(r.bytes / 1024)} KB`);
        return 0;
      }
      if (positionals[1] === 'install' && values.to) {
        const to = values.to.replace(/^~(?=\/)/, homedir());
        console.log(`installed ${installSkill(root, to).files.length} files in ${to}`);
        return 0;
      }
      console.log(USAGE);
      return EXIT.harnessError;
    }
    case 'app': {
      const config = loadConfig(root);
      const port = values.port ? Number(values.port) : (config.app?.port ?? 47320);
      const app = await startApp({ root, port });
      console.log(`Helix Loop on ${app.url}`);
      await new Promise<void>((resolve) => {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(resolve));
      });
      return 0;
    }
    case 'run': {
      const dry = values['dry-run'] ? prepareDryRun(root) : undefined;
      let config = dry ? dry.config : loadConfig(root);
      if (dry && values['config-changes']) {
        // Try in dry run: the app's change set, applied to the dry run's own config.
        const file = join(dry.root, 'harness', 'config.yaml');
        writeFileSync(file, applyToText(readFileSync(file, 'utf8'), JSON.parse(readFileSync(values['config-changes'], 'utf8'))));
        config = loadConfig(dry.root);
        console.log(`with the config change set from ${values['config-changes']}`);
      }
      if (dry && values['plan-changes']) {
        // Try in dry run, for a fix: its plan changes applied to the dry run's copy of the plan.
        const r = await applyChanges(dry.root, JSON.parse(readFileSync(values['plan-changes'], 'utf8')), { what: 'the fix tried in this dry run', by: 'Daniel' });
        console.log(`with a fix applied: ${r.tasks.join(', ') || 'no task changed'}`);
      }
      if (dry) {
        Object.assign(process.env, dry.env);
        console.log(`dry run in ${dry.root}, with the fake CLIs`);
      }
      if (values.agents !== undefined) {
        const chosen = values.agents.split(',').map((a) => a.trim()).filter(Boolean);
        const unknown = chosen.filter((a) => !(AGENTS as readonly string[]).includes(a));
        if (!chosen.length || unknown.length) {
          console.log(`--agents takes ${AGENTS.join(', ')} or both, comma-separated; not ${values.agents}`);
          return EXIT.harnessError;
        }
        for (const a of AGENTS) config.agents[a].enabled = chosen.includes(a);
      }
      const ac = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());
      return runLoop({
        config,
        paths: dry ? paths(dry.root) : p,
        clock: systemClock,
        adapters: {
          claude: claudeAdapter(config.agents.claude, config),
          codex: dry ? codexAdapter(config.agents.codex, config, dry.codexHome) : codexAdapter(config.agents.codex, config),
        },
        notify: macNotifier(config.notify.macos, projectInfo(config).name),
        renderMap: renderDependencyMap,
        log: (line) => console.log(`${new Date().toLocaleTimeString()} ${line}`),
        maxPasses: values['max-passes'] ? Number(values['max-passes']) : undefined,
        signal: ac.signal,
      });
    }
    default:
      console.log(USAGE);
      return command ? EXIT.harnessError : 0;
  }
}

// taskset import: a TaskSet folder (taskset.yaml, tasks/, human/) or a zip of one, checked, then diffed against
// the running plan; --apply writes it as one commit, --dry-run runs it in runs/dry-run/ instead.
async function importTaskSet(from: string | undefined): Promise<number> {
  if (!from || !existsSync(from)) {
    console.log('taskset import <a plan folder or a zip>');
    return EXIT.harnessError;
  }
  let dir = from;
  if (from.endsWith('.zip')) {
    dir = mkdtempSync(join(tmpdir(), 'helix-taskset-'));
    execFileSync('unzip', ['-q', from, '-d', dir]);
  }
  // The folder may hold plan/ or be it.
  const base = existsSync(join(dir, 'plan', 'tasks')) ? join(dir, 'plan') : existsSync(join(dir, 'tasks')) ? dir : undefined;
  if (!base) {
    console.log(`${from} has no tasks/ folder`);
    return EXIT.harnessError;
  }
  const incoming = loadPlan(join(base, 'tasks'), join(base, 'human'));
  const problems = [...validateSchemas(p.schema, join(base, 'tasks'), join(base, 'human')), ...validateGraph(incoming)];
  for (const x of problems) console.log(`${x.id}: ${x.message}`);
  if (problems.length) {
    console.log(`the TaskSet doesn't validate: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    return EXIT.harnessError;
  }
  const current = loadPlan(p.tasks, p.human);
  const ts = loadTaskSet(root, current);
  const file = existsSync(join(base, 'taskset.yaml')) ? (parse(readFileSync(join(base, 'taskset.yaml'), 'utf8')) as Parameters<typeof diffTaskSet>[3]) : undefined;
  const { diff, plan } = diffTaskSet(current, incoming, new Set(ts.lanes.flatMap((l) => l.epics.map((e) => e.id))), file);
  const merged = validateGraph(plan);
  console.log(`+${diff.added.length} tasks${diff.epicsAdded.length ? ` in ${diff.epicsAdded.length} new epics` : ''}`);
  console.log(`~${diff.depsChanged.length} tasks with changed dependencies`);
  console.log(`-${diff.removed.length} tasks removed, none started`);
  if (diff.kept.length) console.log(`${diff.kept.length} merged, running or attempted tasks are kept as they are`);
  console.log(`human tasks: +${diff.human.added.length}`);
  for (const x of merged) console.log(`after import, ${x.id}: ${x.message}`);
  if (merged.length) return EXIT.harnessError;
  if (!values.apply && !values['dry-run']) {
    console.log('nothing written: --apply writes it, --dry-run tries it in runs/dry-run/');
    return 0;
  }
  const target = values['dry-run'] ? prepareDryRun(root).root : root;
  const tp = paths(target);
  for (const id of diff.removed) rmSync(join(tp.tasks, `${id}.yaml`), { force: true });
  for (const t of plan.tasks.values()) writeTask(tp.tasks, t);
  for (const id of diff.human.added) cpSync(join(base, 'human', `${id}.yaml`), join(tp.human, `${id}.yaml`));
  if (file) writeTaskSetFile(target, file);
  if (values['dry-run']) {
    console.log(`written into the dry run in ${target}; start it from the app or with: helix-loop run --dry-run`);
    return 0;
  }
  const n = (existsSync(join(root, '.git')) ? Number(execFileSync('git', ['rev-list', '--count', 'HEAD', '--', 'plan/taskset.yaml'], { cwd: root }).toString().trim()) : 0) + 1;
  const files = [tasksetFile(root), ...[...plan.tasks.keys(), ...diff.removed].map((id) => join(p.tasks, `${id}.yaml`)), ...diff.human.added.map((id) => join(p.human, `${id}.yaml`))].map((f) => relative(root, f));
  if (existsSync(join(root, '.git'))) await commit(root, files.filter((f) => existsSync(join(root, f)) || diff.removed.some((id) => f.endsWith(`${id}.yaml`))), `Plan: import TaskSet rev ${n} (Daniel, in Helix Loop)`);
  console.log(`imported: rev ${n}`);
  return 0;
}

process.exitCode = await main();
