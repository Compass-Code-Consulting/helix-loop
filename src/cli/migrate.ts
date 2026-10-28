import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseDocument } from 'yaml';
import { asset, HELIX_DIR, loadConfig, repoDir } from '../config.ts';
import { ignoreRepos } from './shared.ts';

// `helix-loop migrate`: a control plane from before Helix Loop stood alone kept its spec in spec/, its plan in
// plan/, its config in harness/config.yaml and the loop's files in runs/, repos/ and worktrees/. This moves each
// into .helix/: tracked files with git mv, so their history follows; the loop's working folders with a rename,
// then the passes' worktrees are re-linked to their repos. The repos' checkouts go to the project folder, where
// the code belongs (`moveReposOut`). Anything it doesn't know is left where it is, and listed.

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

// The pid of a loop holding this lock, if it is alive.
function loopRunning(lock: string): number | undefined {
  const pid = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
  return pid > 0 && alive(pid) ? pid : undefined;
}

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
    if (!existsSync(join(h, 'repos'))) {
      out(`${root} has a .helix/ already: nothing to migrate.`);
      return false;
    }
    // A project from when the repos' checkouts lived in .helix/repos/.
    const running = loopRunning(join(h, 'runs', 'loop.lock'));
    if (running) {
      out(`The loop is running (pid ${running}). Stop it first (helix-loop stop, and wait for it to exit), then migrate.`);
      return false;
    }
    out(`Moving the repos' checkouts out of ${HELIX_DIR}/ into the project${opts.apply ? '' : ' (a dry run: --apply does it)'}:`);
    moveReposOut(root, out, { apply: opts.apply });
    if (opts.apply) out(`\nDone. Review with \`git status\`, check with \`helix-loop doctor\`, then commit .gitignore.`);
    return true;
  }
  if (!existsSync(join(root, 'harness', 'config.yaml'))) {
    out(`${root} has no harness/config.yaml: it is not a control plane from before .helix/.`);
    return false;
  }
  const pid = loopRunning(join(root, 'runs', 'loop.lock'));
  if (pid) {
    out(`The loop is running (pid ${pid}). Stop it first (touch runs/STOP, and wait for it to exit), then migrate.`);
    return false;
  }
  const git = existsSync(join(root, '.git'));
  const tracked = new Set(git ? execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean) : []);
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

  if (git) execFileSync('git', ['add', '--', relative(root, file), relative(root, join(h, '.gitignore')), ...(existsSync(join(h, 'prompts', 'build.md')) ? [relative(root, join(h, 'prompts', 'build.md'))] : [])], { cwd: root });
  moveReposOut(root, out);
  out(`\nDone. Review with \`git status\`, check with \`helix-loop doctor\` and \`helix-loop validate\`, then commit.`);
  return true;
}

// The repos' checkouts, once kept in .helix/repos/ where the code was hidden, move to the project folder (each
// repo's config `path`, <repo>/ by default), and the project's git ignores them. The passes' worktrees stay in
// .helix/worktrees/ and are re-linked to their repo's new place. Returns what it moved, or would.
export function moveReposOut(root: string, out: (s?: string) => void, o: { apply?: boolean } = { apply: true }): string[] {
  const from = join(root, HELIX_DIR, 'repos');
  if (!existsSync(from)) return [];
  const config = loadConfig(root);
  const moved: string[] = [];
  for (const r of readdirSync(from).filter((r) => existsSync(join(from, r, '.git')))) {
    const to = config.repos[r] ? repoDir(config, r) : undefined;
    if (!to) {
      out(`  ${HELIX_DIR}/repos/${r} is no repo the config builds: left where it is.`);
      continue;
    }
    if (existsSync(to)) {
      out(`  ${HELIX_DIR}/repos/${r} stays: ${relative(root, to)}/ is there already. Move one of them yourself.`);
      continue;
    }
    out(`  mv      ${HELIX_DIR}/repos/${r}  →  ${relative(root, to)}/`);
    moved.push(r);
    if (!o.apply) continue;
    renameSync(join(from, r), to);
    relink(root, r, to);
  }
  if (o.apply && existsSync(from) && !readdirSync(from).filter((f) => f !== '.DS_Store').length) rmSync(from, { recursive: true, force: true });
  if (o.apply && moved.length) {
    const added = ignoreRepos(root, moved);
    if (added.length && existsSync(join(root, '.git'))) execFileSync('git', ['add', '--', '.gitignore'], { cwd: root });
  }
  return moved;
}

// A repo's worktrees (.helix/worktrees/<repo>/<pass>, or one level up in older projects) point at the repo's
// .git: after a move, each is repaired by its path. Only those, named: with no paths, repair would follow the
// repo's records to wherever they point, and a copy of a project would re-point the original's worktrees at itself.
function relink(root: string, repo: string, checkout: string): void {
  const trees = join(root, HELIX_DIR, 'worktrees');
  const candidates = existsSync(trees) ? readdirSync(trees).flatMap((d) => [join(trees, d), ...(statSync(join(trees, d)).isDirectory() ? readdirSync(join(trees, d)).map((t) => join(trees, d, t)) : [])]) : [];
  const mine = candidates.filter((t) => existsSync(join(t, '.git')) && statSync(join(t, '.git')).isFile() && readFileSync(join(t, '.git'), 'utf8').includes(`/${repo}/.git/worktrees/`));
  if (mine.length) spawnSync('git', ['worktree', 'repair', ...mine], { cwd: checkout });
  spawnSync('git', ['worktree', 'prune'], { cwd: checkout });
}
