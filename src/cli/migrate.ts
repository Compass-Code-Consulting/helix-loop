import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseDocument } from 'yaml';
import { asset, HELIX_DIR, loadConfig } from '../config.ts';

// `helix-loop migrate`: a control plane from before Helix Loop stood alone kept its spec in spec/, its plan in
// plan/, its config in harness/config.yaml and the loop's files in runs/, repos/ and worktrees/. This moves each
// into .helix/: tracked files with git mv, so their history follows; the loop's working folders with a rename,
// then the passes' worktrees are re-linked to their repos. Anything it doesn't know is left where it is, and
// listed.

export interface MigrateOptions {
  apply: boolean;
  project: { name?: string; owner?: string; timezone?: string };
  envPrefix?: string;
}

interface Move {
  from: string;
  to: string;
  tracked: boolean;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Moves whatever is still at `from` to `to`, merging into a folder already there.
function moveRest(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (!existsSync(to)) return renameSync(from, to);
  if (!statSync(from).isDirectory()) return;
  for (const f of readdirSync(from)) moveRest(join(from, f), join(to, f));
  if (!readdirSync(from).length) rmdirSync(from);
}

export async function migrateLegacy(root: string, opts: MigrateOptions, out: (s?: string) => void): Promise<boolean> {
  const h = join(root, HELIX_DIR);
  if (existsSync(join(h, 'config.yaml'))) {
    out(`${root} has a .helix/ already: nothing to migrate.`);
    return false;
  }
  if (!existsSync(join(root, 'harness', 'config.yaml'))) {
    out(`${root} has no harness/config.yaml: it is not a control plane from before .helix/.`);
    return false;
  }
  const lock = join(root, 'runs', 'loop.lock');
  const pid = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
  if (pid > 0 && alive(pid)) {
    out(`The loop is running (pid ${pid}). Stop it first (touch runs/STOP, and wait for it to exit), then migrate.`);
    return false;
  }
  const git = existsSync(join(root, '.git'));
  const tracked = new Set(git ? execFileSync('git', ['ls-files'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean) : []);
  const isTracked = (rel: string) => tracked.has(rel) || [...tracked].some((f) => f.startsWith(`${rel}/`));
  const moves: Move[] = [];
  const move = (from: string, to: string) => {
    if (existsSync(join(root, from))) moves.push({ from, to: join(HELIX_DIR, to), tracked: isTracked(from) });
  };

  // The spec: its Markdown (keeping its name), its sections and index, and the answers waiting to be folded in.
  for (const f of existsSync(join(root, 'spec')) ? readdirSync(join(root, 'spec')) : []) {
    if (f.endsWith('.md') || f === 'sections' || f === 'index.json') move(join('spec', f), join('spec', f));
  }
  // The plan: tasks, human tasks, the TaskSet and the requirement lists; the rendered documents under their new
  // names, so their history follows.
  for (const f of ['tasks', 'human', 'taskset.yaml', 'synthetic-reqs.yaml', 'deferred-reqs.yaml']) move(join('plan', f), join('plan', f));
  for (const f of existsSync(join(root, 'plan')) ? readdirSync(join(root, 'plan')) : []) {
    const renamed = f.endsWith('HumanImplementationPlan.md') ? 'HumanImplementationPlan.md' : f.endsWith('ImplementationPlan.md') ? 'ImplementationPlan.md' : f.endsWith('DependencyMap.html') ? 'DependencyMap.html' : undefined;
    if (renamed) move(join('plan', f), join('plan', renamed));
  }
  move(join('prompts', 'build.md'), join('prompts', 'build.md'));
  move(join('harness', 'config.yaml'), 'config.yaml');
  move(join('harness', 'helix', 'rules.yaml'), join('helix', 'rules.yaml'));
  for (const f of existsSync(join(root, 'harness', 'helix', 'prompts')) ? readdirSync(join(root, 'harness', 'helix', 'prompts')) : []) {
    if (f.endsWith('.local.md')) move(join('harness', 'helix', 'prompts', f), join('helix', 'prompts', f));
  }
  // The loop's working folders, never tracked.
  move(join('runs', 'app.yaml'), 'app.yaml');
  for (const d of ['runs', 'repos', 'worktrees']) move(d, d);

  out(`Migrating ${root} into ${HELIX_DIR}/${opts.apply ? '' : ' (a dry run: --apply does it)'}:`);
  for (const m of moves) out(`  ${m.tracked ? 'git mv' : 'mv    '}  ${m.from}  →  ${m.to}`);
  const left = ['plan', 'prompts', 'harness', 'spec']
    .flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).map((f) => join(d, f)) : []))
    .filter((f) => !moves.some((m) => m.from === f || f.startsWith(`${m.from}/`)) && !f.endsWith('.DS_Store'));
  if (left.length) {
    out('Left where they are (not the loop\'s, or replaced by the tool\'s own):');
    for (const f of left) out(`  ${f}`);
  }
  if (!opts.apply) return true;

  mkdirSync(h, { recursive: true });
  for (const m of moves) {
    mkdirSync(dirname(join(root, m.to)), { recursive: true });
    if (m.tracked) execFileSync('git', ['mv', '-k', m.from, m.to], { cwd: root });
    // What git doesn't track (a tracked folder's untracked files, or a folder git never saw) follows by hand.
    moveRest(join(root, m.from), join(root, m.to));
  }

  // The config: a project block, and the prefix the product's scripts read the loop's variables under.
  const file = join(h, 'config.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(opts.project)) if (v) doc.setIn(['project', k], v);
  if (opts.envPrefix) doc.set('env_prefix', opts.envPrefix);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  if (!existsSync(join(h, 'prompts', 'build.md'))) {
    mkdirSync(join(h, 'prompts'), { recursive: true });
    copyFileSync(asset('templates', 'prompts', 'build.md'), join(h, 'prompts', 'build.md'));
  }
  if (!existsSync(join(h, '.gitignore'))) copyFileSync(asset('templates', 'gitignore'), join(h, '.gitignore'));
  loadConfig(root); // the moved config must load

  // The passes' worktrees moved with their repos: each repo re-links the ones that are still there.
  const repos = join(h, 'repos');
  const trees = join(h, 'worktrees');
  if (existsSync(repos)) {
    for (const r of readdirSync(repos)) {
      if (!existsSync(join(repos, r, '.git'))) continue;
      const mine = existsSync(trees) ? readdirSync(trees).map((t) => join(trees, t)).filter((t) => existsSync(join(t, '.git')) && readFileSync(join(t, '.git'), 'utf8').includes(`/repos/${r}/.git/worktrees/`)) : [];
      spawnSync('git', ['worktree', 'repair', ...mine], { cwd: join(repos, r) });
      spawnSync('git', ['worktree', 'prune'], { cwd: join(repos, r) });
    }
  }
  if (git) execFileSync('git', ['add', '--', relative(root, file), relative(root, join(h, '.gitignore')), ...(existsSync(join(h, 'prompts', 'build.md')) ? [relative(root, join(h, 'prompts', 'build.md'))] : [])], { cwd: root });
  out(`\nDone. Review with \`git status\`, check with \`helix-loop doctor\` and \`helix-loop validate\`, then commit.`);
  return true;
}
