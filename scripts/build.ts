// Builds dist/ for an installed helix-loop: Node runs the .ts sources directly from a checkout, but strips no
// types under node_modules, so an install runs the compiled .js. Besides the compiler's output, the files the
// code reads beside itself (the metrics page's script and style) and the fake CLIs' launchers go in too.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
for (const f of ['page.css', 'page.js']) copyFileSync(join(root, 'src', 'metrics', f), join(dist, 'src', 'metrics', f));
for (const cli of ['claude', 'codex']) {
  mkdirSync(join(dist, 'fakes'), { recursive: true });
  writeFileSync(join(dist, 'fakes', cli), readFileSync(join(root, 'fakes', cli), 'utf8').replaceAll('fake-agent.ts', 'fake-agent.js'));
  chmodSync(join(dist, 'fakes', cli), 0o755);
}
chmodSync(join(dist, 'bin', 'helix-loop.js'), 0o755);
console.log(`built ${dist}`);
