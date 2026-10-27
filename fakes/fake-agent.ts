// A scripted stand-in for the `claude` and `codex` CLIs, for the dry run. It speaks each CLI's
// real output format (captured from live runs on 2026-10-23), so the dry run exercises the real
// adapters. What it does per task comes from a scenario file:
//
//   HELIX_FAKE_SCENARIO  JSON: { "T-0001": ["implement"], "T-0002@codex": ["limit:90", "implement"] }
//                        A list is consumed one entry per call; "T-x@agent" lists win over "T-x".
//   HELIX_FAKE_STATE     directory for call counters and session-limit state, one file per agent, and
//                        each task's latest arguments, prompt and environment variable names
//                        (<task>@<agent>.args.json, .prompt.md, .env.json), and every prompt the task got,
//                        numbered by its call across both agents (<task>.prompt-<n>.md)
//   HELIX_LOOP_NOW       the loop's clock (virtual in the dry run)
//   CODEX_HOME           where the codex fake writes its rollout file
//
// A "*" list applies to every task without one of its own. Actions: work:<s> (<s> real seconds of reported
//          work, for a watched dry run) · issue:<kind>+<action> (reports an issue first) · implement · commit · shared · dep · jsondep · fail · flaky · clash · resolve · unclash · runsuite · untracked · buildstep · ciwrite · infrawrite · tamper · nothing · blocked · forbidden · secret · background
//          · error · transient · suspend · slow:<s> · linger:<s> · stall:<s> · limit:<min> · limit-unknown · cost:<usd>
//          (linger:<s> is slow:<s> that, like the real CLIs, takes 2 seconds to exit after SIGTERM; stall:<s>
//          implements first, then works <s> seconds more, so a pass killed meanwhile leaves its work behind)
//          · upstream[:<repo>] · diverge[:<repo>] · reconcile:<repo>   (someone else pushes to origin mid-pass)
//          (cost:<usd> may prefix another action: "cost:300+implement")
//          · weekly:<percent> prefixes an action too ("weekly:80+implement"): the CLI reports that share of its
//            weekly window used, as each real CLI does (Claude in a rate_limit_event, Codex in its rollout file),
//            with the window halfway through

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const kind = process.argv[2] as 'claude' | 'codex';
const args = process.argv.slice(3);

// The loop's sign-in check (agents/auth.ts), answered as each CLI does. HELIX_FAKE_AUTH_CLAUDE or _CODEX (or
// HELIX_FAKE_AUTH for both) picks another answer: "apikey" or "signedout".
if (args.join(' ') === 'auth status --json' || args.join(' ') === 'login status') {
  const auth = process.env[`HELIX_FAKE_AUTH_${kind.toUpperCase()}`] ?? process.env.HELIX_FAKE_AUTH ?? 'subscription';
  if (kind === 'claude') {
    const method = auth === 'apikey' ? 'api_key' : 'claude.ai';
    process.stdout.write(JSON.stringify({ loggedIn: auth !== 'signedout', authMethod: auth === 'signedout' ? 'none' : method, apiProvider: 'firstParty' }, null, 2) + '\n');
  } else process.stdout.write(auth === 'apikey' ? 'Logged in using an API key - sk-proj-***fake\n' : auth === 'signedout' ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
  process.exit(auth === 'signedout' && kind === 'codex' ? 1 : 0);
}

const now = Number(process.env.HELIX_LOOP_NOW ?? Date.now());
const stateDir = process.env.HELIX_FAKE_STATE!;
const scenario = JSON.parse(readFileSync(process.env.HELIX_FAKE_SCENARIO!, 'utf8')) as Record<string, string[]>;
const cwd = kind === 'codex' && args.includes('-C') ? args[args.indexOf('-C') + 1]! : process.cwd();
const prompt = readFileSync(0, 'utf8');

interface AgentState {
  calls: Record<string, number>;
  limitedUntil: number;
}
const stateFile = (a: string) => join(stateDir, `${a}.json`);
const readState = (a: string): AgentState => (existsSync(stateFile(a)) ? JSON.parse(readFileSync(stateFile(a), 'utf8')) : { calls: {}, limitedUntil: 0 });
mkdirSync(stateDir, { recursive: true });
const state = readState(kind);
// Replaced whole (temp file, then rename): the other agent's fake reads this file to count shared calls
// and must never see it half written.
const save = () => {
  const tmp = `${stateFile(kind)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, stateFile(kind));
};

const isProbe = /Reply with the single word OK/.test(prompt);
const taskId = /```yaml\nid: (T-\d{4})/.exec(prompt)?.[1];
if (taskId) {
  writeFileSync(join(stateDir, `${taskId}@${kind}.args.json`), JSON.stringify(args));
  writeFileSync(join(stateDir, `${taskId}@${kind}.prompt.md`), prompt);
  writeFileSync(join(stateDir, `${taskId}@${kind}.env.json`), JSON.stringify(Object.keys(process.env).sort()));
}

function chooseAction(): string {
  if (!taskId) return 'nothing';
  const own = scenario[`${taskId}@${kind}`];
  if (own) {
    const n = state.calls[`${taskId}@${kind}`] ?? 0;
    state.calls[`${taskId}@${kind}`] = n + 1;
    return own[Math.min(n, own.length - 1)]!;
  }
  const shared = scenario[taskId] ?? scenario['*'] ?? ['implement'];
  const other = readState(kind === 'claude' ? 'codex' : 'claude');
  const n = (state.calls[taskId] ?? 0) + (other.calls[taskId] ?? 0);
  state.calls[taskId] = (state.calls[taskId] ?? 0) + 1;
  writeFileSync(join(stateDir, `${taskId}.prompt-${n + 1}.md`), prompt);
  return shared[Math.min(n, shared.length - 1)]!;
}

// ---- output in each CLI's format ----
// Builder passes read stream-json; Helix asks for one JSON object at the end (--output-format json), as the
// real CLI gives it: the result, with its session.
const jsonOnly = kind === 'claude' && args[args.indexOf('--output-format') + 1] === 'json';
const out = (o: unknown) => {
  if (jsonOnly && (o as { type?: string }).type !== 'result') return;
  process.stdout.write(JSON.stringify(jsonOnly ? { ...(o as object), session_id: threadId } : o) + '\n');
};
const threadId = `0199fake-${kind}-${now}-${Math.random().toString(16).slice(2, 8)}`;

// The share of the weekly window the CLI reports as used, when the action says (weekly:<percent>).
let weekly: number | undefined;
const WEEK_RESETS_IN_MS = 84 * 3_600_000;

function rolloutLine(rateLimits: unknown): void {
  const d = new Date(now);
  const dir = join(process.env.CODEX_HOME!, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `rollout-fake-${threadId}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rateLimits } }) + '\n');
}

function finishOk(message: string, cost = 0.5): never {
  const resetsAt = Math.floor((now + WEEK_RESETS_IN_MS) / 1000);
  if (kind === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: threadId, model: 'fake' });
    if (weekly !== undefined) {
      const fiveHour = { utilization: 0.1, resetsAt: Math.floor((now + 3 * 3_600_000) / 1000) };
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: fiveHour, seven_day: { utilization: weekly, resetsAt } } } });
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: message }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: message, total_cost_usd: cost, usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 200 } });
  } else {
    out({ type: 'thread.started', thread_id: threadId });
    if (weekly !== undefined) rolloutLine({ limit_id: 'codex', primary: { used_percent: weekly * 100, window_minutes: 10080, resets_at: resetsAt }, secondary: null, plan_type: 'pro', rate_limit_reached_type: null });
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: message } });
    // Tokens sized so the adapter's price table yields roughly `cost`.
    out({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: Math.round((cost / 10) * 1e6), reasoning_output_tokens: 0 } });
  }
  process.exit(0);
}

function finishLimited(until: number | null): never {
  if (kind === 'claude') {
    const time = until
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true })
          .format(until)
          .replace(' ', '')
          .toLowerCase()
      : null;
    const text = time ? `You've hit your session limit · resets ${time} (America/Chicago)` : "You've hit your session limit";
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: text, total_cost_usd: 0 });
    process.exit(1);
  }
  out({ type: 'thread.started', thread_id: threadId });
  // Codex records the windows in its rollout file; the adapter reads resets_at from there.
  if (until) rolloutLine({ limit_id: 'codex', primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(until / 1000) }, secondary: null, plan_type: 'pro', rate_limit_reached_type: 'primary' });
  const msg = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.";
  out({ type: 'error', message: msg });
  out({ type: 'turn.failed', error: { message: msg } });
  process.exit(1);
}

// ---- what an action does to the worktree ----
function acceptanceTitles(): string[] {
  const yamlBlock = /```yaml\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? '';
  const t = parse(yamlBlock) as { acceptance?: string[] };
  return (t.acceptance ?? []).map((a) => a.replace(/^(e2e|unit|integration):\s*/, ''));
}

// Another repo's primary checkout, beside this worktree's own (no sandbox in the dry run).
const primary = (repo: string) => join(execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd }).toString().trim(), '..', '..', repo);

// A clone of origin made just now, as another person's would be: of this pass's repo, or of `repo`.
const OTHER_PERSON = ['-c', 'user.name=Someone Else', '-c', 'user.email=other@example.com'];
function otherClone(repo?: string): string {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo ? primary(repo) : cwd }).toString().trim();
  const dir = join(stateDir, `${taskId}-${kind}-other-clone`);
  rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', origin, dir]);
  return dir;
}

// What the failure actions plant, taken out again when an attempt finds it in the worktree as kept work,
// as a real agent fixes what its last attempt's note names. Only files git doesn't track yet count.
function fixKeptWork(): void {
  for (const f of ['GATE_FAIL', 'FLAKY', '.github/workflows/deploy.yml', 'src/config.ts']) {
    const tracked = (() => {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
    if (!tracked) rmSync(join(cwd, f), { force: true });
  }
}

function implement(): void {
  const id = taskId!;
  fixKeptWork();
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'src', `${id}.ts`), `export const ${id.replace('-', '_')} = ${JSON.stringify(id)};\n`);
  writeFileSync(join(cwd, 'test', `${id}.test.ts`), acceptanceTitles().map((t) => `test(${JSON.stringify(t)}, () => {});\n`).join(''));
}

// ---- the loop app's MCP endpoint, when the pass was given one (agents/adapter.ts PassMcp) ----
const mcp = (() => {
  if (kind === 'claude') {
    const i = args.indexOf('--mcp-config');
    if (i < 0) return undefined;
    const s = (JSON.parse(args[i + 1]!) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }).mcpServers.helix!;
    return { url: s.url, auth: s.headers.Authorization! };
  }
  const url = args.find((a) => a.startsWith('mcp_servers.helix.url='));
  return url ? { url: JSON.parse(url.slice('mcp_servers.helix.url='.length)) as string, auth: `Bearer ${process.env.HELIX_MCP_TOKEN}` } : undefined;
})();
// One tool call, as the CLI makes it; a refused or failed call is reported on stderr and never fails the pass.
async function report(tool: string, input: Record<string, unknown>): Promise<void> {
  if (!mcp) return;
  try {
    const res = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: mcp.auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } }),
    });
    const body = (await res.json()) as { result?: { isError?: boolean } };
    if (!res.ok || body.result?.isError) process.stderr.write(`fake: ${tool} refused (${res.status})\n`);
    if (kind === 'claude') out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${tool}`, name: `mcp__helix__${tool}`, input }] } });
    else out({ type: 'item.completed', item: { id: `item_${tool}`, type: 'mcp_tool_call', server: 'helix', tool, status: 'completed' } });
  } catch (e) {
    process.stderr.write(`fake: ${tool} failed: ${(e as Error).message}\n`);
  }
}

const raw = isProbe ? 'probe' : chooseAction();
let action = raw;
let cost = 0.5;
let issue: string | undefined; // "issue:<kind>+<action>": report an issue, then do the action
if (action.startsWith('issue:')) {
  const [k, rest] = action.slice(6).split('+');
  issue = k;
  action = rest ?? 'implement';
}
for (let m; (m = /^(cost|weekly):([\d.]+)(?:\+|$)/.exec(action)); ) {
  if (m[1] === 'cost') cost = Number(m[2]);
  else weekly = Number(m[2]) / 100;
  action = action.slice(m[0].length) || 'implement';
}
save();
if (taskId && !isProbe) {
  await report('report_progress', { message: `Reading ${taskId} and the spec sections it cites` });
  if (issue) await report('report_issue', { kind: issue, message: `The spec doesn't say what ${taskId} should do when the list is empty; I assumed an empty state.` });
}

if (state.limitedUntil > now) finishLimited(state.limitedUntil);
if (isProbe) finishOk('OK', 0.01);

const [verb, param] = action.split(':');
const message = (body: string) => `${taskId}: ${body}\n\nDone by the ${kind} fake.`;
switch (verb) {
  case 'implement':
    implement();
    finishOk(message('implement the task'), cost);
  case 'commit':
    implement();
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', `${taskId}: committed by the agent itself`], { cwd });
    finishOk(message('committed by the agent'), cost);
  case 'shared':
    // Every task with this action rewrites the same line, so the second to merge conflicts.
    implement();
    writeFileSync(join(cwd, 'shared.txt'), `written by ${taskId} via ${kind}\n`);
    finishOk(message('touch the shared file'), cost);
  case 'dep':
    // Adds a dependency as a package manager does: an entry of its own in the manifests, and a lockfile
    // rebuilt from every entry, so two tasks' lockfiles conflict while their manifests merge.
    implement();
    mkdirSync(join(cwd, 'deps'), { recursive: true });
    writeFileSync(join(cwd, 'deps', taskId!), `${taskId}\n`);
    execFileSync('/bin/sh', ['-c', 'cat deps/* | sort > deps.lock'], { cwd });
    finishOk(message('add a dependency'), cost);
  case 'jsondep': {
    // Adds a dependency to a JSON manifest and rebuilds the lockfile derived from it: two tasks doing this
    // conflict in both files, as two tasks adding packages to one package.json do.
    implement();
    const manifestFile = join(cwd, 'manifest.json');
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { name: 'fake', dependencies: {} };
    manifest.dependencies[taskId!.toLowerCase()] = '1.0.0';
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(cwd, 'manifest.lock'), `${Object.keys(manifest.dependencies).sort().join('\n')}\n`);
    finishOk(message('add a dependency to the manifest'), cost);
  }
  case 'fail':
    implement();
    writeFileSync(join(cwd, 'GATE_FAIL'), 'the fake gate fails while this file exists\n');
    finishOk(message('implement, but break the gate'), cost);
  case 'flaky':
    // Fails the gate on a test every task with this action shares, as a flaky test fails unrelated tasks.
    implement();
    writeFileSync(join(cwd, 'FLAKY'), 'the fake gate fails the shared test while this file exists\n');
    finishOk(message('implement, and meet the shared flaky test'), cost);
  case 'clash':
    // Passes the gate alone, but the fake gate fails while two tasks' clash files sit side by side: the
    // second of two such tasks to merge fails only after its rebase onto the first.
    implement();
    writeFileSync(join(cwd, `CLASH_${taskId}`), 'the fake gate fails while two of these exist\n');
    finishOk(message('implement a change that clashes with another'), cost);
  case 'runsuite':
    // Runs the whole integration suite before finishing, as the build prompt asks: the loop counts it.
    implement();
    if (kind === 'claude') out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: { command: 'pnpm test:integration' } }] } });
    else out({ type: 'item.completed', item: { id: 'item_9', type: 'command_execution', command: "/bin/zsh -lc 'pnpm test:integration && pnpm vitest run src'", exit_code: 0, status: 'completed' } });
    finishOk(message('implement, and run the integration suite'), cost);
  case 'resolve':
  case 'unclash': {
    // Finishes the work an earlier attempt kept, which the loop put in this worktree, and records what was
    // found: "resolve" keeps both sides of each conflict in shared.txt, "unclash" drops this task's clash file.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd }).toString();
    const shared = readFileSync(join(cwd, 'shared.txt'), 'utf8');
    writeFileSync(join(stateDir, `${taskId}@${kind}.carried.json`), JSON.stringify({ status, shared }));
    if (verb === 'unclash') {
      rmSync(join(cwd, `CLASH_${taskId}`), { force: true });
      finishOk(message('drop the clashing change'), cost);
    }
    let side: 'both' | 'base' = 'both';
    const kept = shared.split('\n').filter((l) => {
      if (/^(<{7}|>{7})( |$)/.test(l) || /^={7}$/.test(l)) return ((side = 'both'), false);
      if (/^\|{7}( |$)/.test(l)) return ((side = 'base'), false);
      return side === 'both';
    });
    writeFileSync(join(cwd, 'shared.txt'), kept.join('\n'));
    finishOk(message('resolve the conflict, keeping both sides'), cost);
  }
  case 'untracked':
  case 'buildstep':
    // Code that needs a build output (NEEDS_BUILT) git ignores, built by hand in the worktree; only
    // "buildstep" commits the build script the prepare step runs, as a fresh checkout needs.
    implement();
    writeFileSync(join(cwd, '.gitignore'), 'built/\n');
    writeFileSync(join(cwd, 'NEEDS_BUILT'), 'the fake gate fails unless built/ok exists\n');
    if (verb === 'buildstep') writeFileSync(join(cwd, 'build.sh'), 'mkdir -p built && touch built/ok\n');
    mkdirSync(join(cwd, 'built'), { recursive: true });
    writeFileSync(join(cwd, 'built', 'ok'), '');
    finishOk(message(verb === 'buildstep' ? 'implement, with its build step' : 'implement on an untracked build'), cost);
  case 'ciwrite':
    implement();
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'workflows', 'ci.yml'), 'on: [push, pull_request]\n');
    finishOk(message('add the CI workflow'), cost);
  case 'infrawrite':
    implement();
    mkdirSync(join(cwd, 'infra'), { recursive: true });
    writeFileSync(join(cwd, 'infra', 'main.tf'), 'resource "digitalocean_app" "web" {}\n');
    finishOk(message('add the infrastructure code'), cost);
  case 'tamper': {
    // Writes outside its worktree, into the repository's primary checkout (no sandbox in the dry run).
    implement();
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd }).toString().trim();
    writeFileSync(join(common, '..', 'TAMPERED.txt'), 'written from a task worktree\n');
    finishOk(message('tamper with the primary checkout'), cost);
  }
  case 'upstream': {
    // Someone else pushes to origin/main while this pass runs.
    implement();
    const other = otherClone(param);
    writeFileSync(join(other, `upstream-${taskId}.txt`), 'pushed by someone else\n');
    execFileSync('git', ['add', '-A'], { cwd: other });
    execFileSync('git', [...OTHER_PERSON, 'commit', '-q', '-m', `Upstream change during ${taskId}`], { cwd: other });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });
    finishOk(message('implement while someone pushes to origin'), cost);
  }
  case 'diverge': {
    // Someone else rewrites origin/main while this pass runs: its tip is amended and force-pushed.
    implement();
    const other = otherClone(param);
    execFileSync('git', [...OTHER_PERSON, 'commit', '-q', '--amend', '--allow-empty', '-m', `Rewritten during ${taskId}`], { cwd: other });
    execFileSync('git', ['push', '-q', '--force', 'origin', 'main'], { cwd: other });
    finishOk(message('implement while someone rewrites origin'), cost);
  }
  case 'reconcile': {
    // Stands in for a person settling the diverged repo `param` by pushing its main over origin's.
    implement();
    execFileSync('git', ['push', '-q', '--force', 'origin', 'main'], { cwd: primary(param!) });
    finishOk(message(`implement and reconcile ${param}`), cost);
  }
  case 'nothing':
    finishOk(message('nothing to do'), cost);
  case 'blocked':
    finishOk('BLOCKED: the spec contradicts itself on this point; a person must decide.', cost);
  case 'forbidden':
    implement();
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.github', 'workflows', 'deploy.yml'), 'on: push\n');
    finishOk(message('also edit a workflow'), cost);
  case 'secret': {
    implement();
    const token = 'ghp_' + 'x7Kq2Lm9Rt4Vb8Nc3Zw6Yp1Hd5Fg0Js2Ae7U'.slice(0, 36);
    writeFileSync(join(cwd, 'src', 'config.ts'), `export const githubToken = "${token}";\n`);
    finishOk(message('hard-code a token'), cost);
  }
  case 'background': {
    implement();
    // Same process group as this fake, so the harness's group kill must take it down.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    writeFileSync(join(stateDir, `${taskId}.bgpid`), String(child.pid));
    child.unref();
    finishOk(message('leave a background process running'), cost);
  }
  case 'error':
    process.stderr.write('fake: unexpected crash\n');
    process.exit(2);
  case 'transient':
    if (kind === 'claude') {
      out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded', total_cost_usd: 0 });
    } else {
      out({ type: 'error', message: 'stream disconnected before completion: 503 Service Unavailable' });
    }
    process.exit(1);
  case 'suspend':
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.', total_cost_usd: 0 });
    process.exit(1);
  case 'work': {
    // Real-time work in three steps, each reported as a builder would, and each as a builder's log shows it: its
    // words, a read, an edit and a command (one tool call per step counts, as the loop's tests expect).
    const steps = ['Writing the acceptance tests', 'Implementing the change', 'Running the integration suite'];
    const file = ['src/feature.test.ts', 'src/feature.ts', 'docs/feature.md'];
    for (const [i, step] of steps.entries()) {
      await report('report_progress', { message: step });
      if (kind === 'claude') {
        out({ type: 'assistant', message: { content: [{ type: 'text', text: `${step}.` }] } });
        out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_work_${i}`, name: 'Bash', input: { command: 'pnpm test:unit', description: `Check: ${file[i]}` } }] } });
        out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_work_${i}`, content: ` ✓ ${file[i]} (3 tests)\n Test Files  1 passed (1)` }] } });
      } else {
        out({ type: 'item.completed', item: { id: `item_${i}_m`, type: 'agent_message', text: `${step}.` } });
        out({ type: 'item.completed', item: { id: `item_work_${i}`, type: 'command_execution', command: "/bin/zsh -lc 'pnpm test:unit'", aggregated_output: ` ✓ ${file[i]} (3 tests)\n`, exit_code: 0, status: 'completed' } });
      }
      await new Promise((r) => setTimeout(r, (Number(param) * 1000) / steps.length));
    }
    implement();
    finishOk(message('implement the task, step by step'), cost);
  }
  case 'stall':
    implement();
    await new Promise((r) => setTimeout(r, Number(param) * 1000));
    finishOk(message('stall'), cost);
  case 'linger':
    process.on('SIGTERM', () => setTimeout(() => process.exit(143), 2000));
  // falls through
  case 'slow':
    await new Promise((r) => setTimeout(r, Number(param) * 1000));
    implement();
    finishOk(message('slow'), cost);
  case 'limit':
    state.limitedUntil = now + Number(param) * 60_000;
    save();
    finishLimited(state.limitedUntil);
  case 'limit-unknown':
    state.limitedUntil = now + 10 * 60_000;
    save();
    finishLimited(null);
  default:
    process.stderr.write(`fake: unknown action ${action}\n`);
    process.exit(2);
}
