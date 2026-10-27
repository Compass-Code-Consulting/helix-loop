import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CONTROL_PLANE } from '../src/config.ts';
import { E2ERunner } from '../src/e2e-runner.ts';

const exec = promisify(execFile);
const CLIENT = join(CONTROL_PLANE, 'harness', 'clients', 'e2e-client.mjs');

test('the e2e runner runs the worktree script for a registered pass and returns its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-e2e-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'w', private: true, scripts: { 'e2e:direct': 'node -e "console.log(\'ran \' + process.argv.slice(1).join(\' \')); process.exit(3)"' } }),
  );
  const runner = new E2ERunner('e2e:direct', 60_000, () => {});
  const url = await runner.start(0);
  const pass = runner.register(dir);
  const env = { ...process.env, MUSHY_E2E_RUNNER: url, MUSHY_E2E_PASS: pass };
  const res = await exec('node', [CLIENT, 'e2e/home.spec.ts', '--grep', '[AN-1]'], { env }).catch((e) => e as { code: number; stdout: string });
  assert.equal((res as { code: number }).code, 3);
  assert.match((res as { stdout: string }).stdout, /ran e2e\/home\.spec\.ts --grep \[AN-1\]/);
  assert.doesNotMatch((res as { stdout: string }).stdout, /__MUSHY_E2E_EXIT__/);

  runner.unregister(pass);
  const refused = await exec('node', [CLIENT], { env }).catch((e) => e as { code: number; stderr: string });
  assert.equal((refused as { code: number }).code, 2);
  assert.match((refused as { stderr: string }).stderr, /unknown or expired pass/);
  await runner.stop();
});

test('a run ends with its pass, and once the runner stops, the process can exit at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-e2e-'));
  const pidFile = join(dir, 'run.pid');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'w', private: true, scripts: { 'e2e:direct': `echo $$ > ${pidFile}; exec sleep 120` } }));
  // In its own process, as the loop is: start a run, end the pass, stop the runner, and then wait for
  // nothing. Before the fix this process lived until the run's timeout, holding the loop's exit.
  const script = `
    import { existsSync, readFileSync } from 'node:fs';
    import { E2ERunner } from ${JSON.stringify(new URL('../src/e2e-runner.ts', import.meta.url).href)};
    const runner = new E2ERunner('e2e:direct', 20 * 60_000, () => {});
    const url = await runner.start(0);
    const pass = runner.register(${JSON.stringify(dir)});
    fetch(url + '/run', { method: 'POST', headers: { 'x-mushy-pass': pass }, body: '{}' }).then((r) => r.text()).catch(() => '');
    for (let i = 0; i < 100 && !existsSync(${JSON.stringify(pidFile)}); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
    runner.unregister(pass);
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    await runner.stop();
    console.log(alive ? 'run still alive' : 'run stopped');
  `;
  const started = Date.now();
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000 });
  assert.match(stdout, /run stopped/);
  assert.ok(Date.now() - started < 15_000, `the process took ${Date.now() - started} ms to exit`);
});
