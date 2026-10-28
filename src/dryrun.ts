import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { asset, configPath, loadConfig, paths, type Config } from './config.ts';
import type { Task } from './types.ts';

// The dry run: the real loop, the real adapters and real git repositories, with scripted fake `claude` and
// `codex` executables (fakes/) in place of the CLIs. The tool's tests run it at a thousand times real speed;
// `helix-loop run --dry-run` runs it at real speed on a copy of the plan, in .helix/runs/dry-run/, so the app
// can be watched and tried without touching the real loop, its repos or its ledger.

// The fake CLIs' launchers: beside the sources in a checkout, compiled under dist/ when installed.
export const FAKES = import.meta.url.endsWith('.ts') ? asset('fakes') : asset('dist', 'fakes');

// The parts of a project a loop reads but never writes: the spec index, the prompts, the TaskSet's file and its
// milestones.
export function seedControlPlane(root: string, from: string): void {
  const src = paths(from);
  const p = paths(root);
  for (const d of [p.specSections, p.prompts, p.tasks, p.human]) mkdirSync(d, { recursive: true });
  cpSync(src.specSections, p.specSections, { recursive: true });
  cpSync(src.specIndex, p.specIndex);
  cpSync(src.prompts, p.prompts, { recursive: true });
  // The requirement lists too: without them the dry run's plan cites requirements it can't find.
  for (const f of ['taskset', 'milestones', 'syntheticReqs', 'deferredReqs'] as const) if (existsSync(src[f])) cpSync(src[f], p[f]);
}

// One throwaway repository per product repo, each with a skeleton commit on main.
export function seedRepos(reposDir: string, repos: string[]): void {
  for (const repo of repos) {
    const dir = join(reposDir, repo);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, 'shared.txt'), 'original\n');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'skeleton'], { cwd: dir });
  }
}

// The config with the fakes in place of the CLIs and a fake gate, for a loop rooted at `root`. The gate fails
// while the pass leaves FLAKY behind (a test shared by tasks), in colour as test runners do while it leaves GATE_FAIL, or code that needs built/ok without it,
// or two tasks' clash files side by side; the prepare step runs the build script a task commits.
export function fakeConfig(base: Config, root: string): Config {
  const config: Config = structuredClone({ ...base, root });
  config.agents.claude.command = join(FAKES, 'claude');
  config.agents.codex.command = join(FAKES, 'codex');
  for (const r of Object.values(config.repos)) {
    r.gate =
      "echo '> gate 10-check: the fake gate'; if [ -f FLAKY ]; then echo ' FAIL  |unit| test/flaky.test.ts > [PB-14] the shared dry-run test'; exit 1; fi; if [ -f GATE_FAIL ]; then printf 'building\\n\\033[31m✖ adds numbers (2ms)\\033[39m\\n'; exit 1; fi; if [ -f NEEDS_BUILT ] && [ ! -f built/ok ]; then echo '✖ built/ok is missing'; exit 1; fi; " +
      "if [ $(ls CLASH_* 2>/dev/null | wc -l) -gt 1 ]; then echo '✖ two clashing changes'; exit 1; fi";
    r.prepare = 'test ! -f build.sh || sh build.sh';
  }
  config.relock = {
    'deps.lock': 'cat deps/* | sort > deps.lock',
    'manifest.lock': `node -e "const m = require('./manifest.json'); process.stdout.write(Object.keys(m.dependencies).sort().join('\\n') + '\\n')" > manifest.lock`,
  };
  config.json_merge = { 'manifest.json': '' };
  config.push = false;
  config.notify.macos = false;
  // The real config may hold a repo's releases until a human task the dry-run plan doesn't have.
  config.release.hold_until = {};
  if (config.e2e_runner) config.e2e_runner.port = 0;
  return config;
}

// What each fake pass does in a watched dry run: about twenty seconds of reported work, with every sixth task
// first reporting an issue and every ninth failing the gate once, so the map, the reports and a retry all show.
export function watchedScenario(ready: string[]): Record<string, string[]> {
  const scenario: Record<string, string[]> = { '*': ['work:20'] };
  ready.forEach((id, i) => {
    if (i % 9 === 8) scenario[id] = ['fail', 'work:20'];
    else if (i % 6 === 5) scenario[id] = ['issue:spec_question+work:20'];
  });
  return scenario;
}

export interface DryRun {
  root: string;
  config: Config;
  codexHome: string;
  env: Record<string, string>; // what the fakes read
}

// A fresh dry run in runs/dry-run/ of `controlPlane`: a copy of its plan as it stands (claims dropped), fresh
// repos, and the fakes. Whatever an earlier dry run left there is removed first.
export function prepareDryRun(controlPlane: string): DryRun {
  const root = paths(controlPlane).dryRun;
  rmSync(root, { recursive: true, force: true });
  seedControlPlane(root, controlPlane);
  const src = paths(controlPlane);
  const p = paths(root);
  const ready: string[] = [];
  for (const f of readdirSync(src.tasks).filter((f) => f.endsWith('.yaml'))) {
    const t = parse(readFileSync(join(src.tasks, f), 'utf8')) as Task;
    if (t.status === 'claimed') Object.assign(t, { status: 'ready', claimed_by: null });
    if (t.status === 'ready') ready.push(t.id);
    writeFileSync(join(p.tasks, f), stringify(t, { lineWidth: 0 }));
  }
  cpSync(src.human, p.human, { recursive: true });
  const config = fakeConfig(loadConfig(controlPlane), root);
  seedRepos(p.repos, Object.keys(config.repos));
  writeFileSync(configPath(root), stringify({ ...config, root: undefined }));
  mkdirSync(p.runs, { recursive: true });
  const scenarioFile = join(root, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(watchedScenario(ready.sort())));
  return { root, config, codexHome: join(root, 'codex-home'), env: { HELIX_FAKE_SCENARIO: scenarioFile, HELIX_FAKE_STATE: join(root, 'fake-state') } };
}
