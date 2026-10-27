#!/usr/bin/env node
// Runs the worktree's browser tests through the loop's e2e runner (harness/src/e2e-runner.ts),
// for agents whose sandbox cannot start Chromium. A repo's `pnpm e2e` calls this when the loop has
// set MUSHY_E2E_CLIENT; otherwise it runs Playwright directly. Arguments pass through unchanged.
const url = process.env.MUSHY_E2E_RUNNER;
const pass = process.env.MUSHY_E2E_PASS;
if (!url || !pass) {
  console.error('mushy e2e client: MUSHY_E2E_RUNNER and MUSHY_E2E_PASS must be set (they are, inside a loop pass)');
  process.exit(2);
}
const MARKER = '__MUSHY_E2E_EXIT__=';
let res;
try {
  res = await fetch(`${url}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mushy-pass': pass },
    body: JSON.stringify({ args: process.argv.slice(2) }),
  });
} catch (e) {
  console.error(`mushy e2e client: cannot reach the runner at ${url}: ${e.message}`);
  process.exit(2);
}
if (!res.ok) {
  console.error(`mushy e2e client: runner refused (${res.status}): ${await res.text()}`);
  process.exit(2);
}
let tail = '';
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  const text = decoder.decode(chunk, { stream: true });
  tail = (tail + text).slice(-200);
  process.stdout.write(text.replace(new RegExp(`\\n?${MARKER}\\d+\\n?$`), ''));
}
const m = new RegExp(`${MARKER}(\\d+)`).exec(tail);
process.exit(m ? Number(m[1]) : 1);
