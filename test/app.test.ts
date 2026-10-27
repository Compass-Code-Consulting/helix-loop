import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { claudeSignIn, codexSignIn } from '../src/agents/auth.ts';
import { claudeAdapter, describeClaude } from '../src/agents/claude.ts';
import { codexAdapter, unwrapShell } from '../src/agents/codex.ts';
import { loadQuota, mapAgents } from '../src/agents/quota.ts';
import { loadConfig, paths } from '../src/config.ts';
import { seedControlPlane } from '../src/dryrun.ts';
import { hashToken, newToken, type LiveFile } from '../src/live.ts';
import { loadPlan } from '../src/plan/store.ts';
import type { HumanTask, Task } from '../src/types.ts';
import { createTask, PlanEditError, STEWARD_TASK_FIELDS, updateHuman, updateTask } from '../src/app/actions.ts';
import { BUILDER_SERVER, BUILDER_TOOLS, handleRpc, passFor } from '../src/app/mcp.ts';
import { readFeed } from '../src/app/feed.ts';
import { startApp } from '../src/app/server.ts';
import { loopStatus, mapModel, passesNow } from '../src/app/state.ts';
import { ASSISTANT_TOOLS, RESOLVE_REQUEST, type HelixJob } from '../src/app/helix.ts';
import { addComment, addMessage, addProposal, addReply, decide, resolveThread, thread, ThreadError, threadsOf, readEntries } from '../src/app/threads.ts';

// The loop app (spec: Mushy.LoopEngineering.LoopApp.2026-10-25.md): threads, the MCP endpoints, plan edits and
// the server's guards, each against a temporary control plane.

function controlPlane(tasks: Partial<Task>[] = [], humans: (Partial<HumanTask> & { id: string })[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'mushy-app-'));
  seedControlPlane(root);
  const p = paths(root);
  tasks.forEach((t, i) => {
    const id = t.id ?? `T-${String(i + 1).padStart(4, '0')}`;
    const full: Task = { id, repo: 'mushy-social-media', stage: 'day1', area: `area-${id.toLowerCase()}`, title: `App test task ${id}`, reqs: ['PB-14'], spec: ['PB-14'], acceptance: [`unit: [PB-14] behaviour of ${id}`], blocked_by: [], estimate_passes: 1, status: 'ready', claimed_by: null, attempts: [], ...t };
    writeFileSync(join(p.tasks, `${id}.yaml`), stringify(full));
  });
  for (const h of humans) writeFileSync(join(p.human, `${h.id}.yaml`), stringify({ title: `App test human step ${h.id}`, done_check: 'Daniel says it is done', lead_time_days: 1, agent_can_help: 'no', blocked_by: [], status: 'todo', ...h }));
  mkdirSync(join(root, 'harness'), { recursive: true });
  writeFileSync(join(root, 'harness', 'config.yaml'), stringify({ ...loadConfig(), root: undefined, push: false }));
  mkdirSync(p.runs, { recursive: true });
  return root;
}

function livePass(root: string, task: string, agent: 'claude' | 'codex' = 'claude'): string {
  const token = newToken();
  const live: LiveFile = { updatedAt: new Date().toISOString(), pid: process.pid, passes: [{ id: `${task}:${agent}:1`, task, repo: 'mushy-social-media', agent, attempt: 1, startedAt: new Date().toISOString(), phase: 'agent', phaseAt: new Date().toISOString(), toolCalls: 0, tokenHash: hashToken(token) }] };
  writeFileSync(paths(root).live, JSON.stringify(live));
  return token;
}

// ---- threads ----

test('a root comment starts its own thread, with a copy of the comment as its first message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-threads-'));
  const t = addComment(dir, 'T-0034', 'Should this wait on T-0020?');
  assert.equal(t.key, 'T-0034#c1');
  assert.equal(t.root.text, 'Should this wait on T-0020?');
  assert.deepEqual(t.messages.map((m) => [m.author, m.text]), [['daniel', 'Should this wait on T-0020?']]);
  assert.equal(t.state, 'open');
  assert.equal(t.waitingOn, 'helix');
});

test('a reply under a root goes to that root\'s thread and reopens it; a new root comment never does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-threads-'));
  const first = addComment(dir, 'T-0034', 'First point');
  addMessage(dir, first.key, 'helix', 'An answer');
  resolveThread(dir, first.key, 'Decided: nothing changes.');
  assert.equal(thread(dir, first.key)!.state, 'resolved');
  assert.deepEqual(thread(dir, first.key)!.replies.map((r) => r.kind), ['summary']);

  const second = addComment(dir, 'T-0034', 'An independent point');
  assert.equal(second.key, 'T-0034#c2');
  assert.equal(thread(dir, first.key)!.state, 'resolved', 'a new root comment leaves the first thread resolved');

  const reopened = addReply(dir, 'T-0034', first.root.id, 'One more thing on the first point');
  assert.equal(reopened.key, first.key);
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.messages.at(-1)!.text, 'One more thing on the first point');
  assert.deepEqual(reopened.replies.map((r) => r.kind), ['summary', 'reply']);
  assert.equal(threadsOf('T-0034', readEntries(dir, 'T-0034')).length, 2);
});

test('replies go one level deep only, and targets are tasks, human tasks or dependency edges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-threads-'));
  const t = addComment(dir, 'T-1200~T-1180', 'Does this edge belong?');
  assert.equal(t.target, 'T-1200~T-1180');
  addReply(dir, 'T-1200~T-1180', t.root.id, 'A reply');
  const reply = t.root.id.replace('c', 'r');
  assert.throws(() => addReply(dir, 'T-1200~T-1180', reply, 'A reply to a reply'), ThreadError);
  assert.throws(() => addComment(dir, '../etc/passwd', 'x'), ThreadError);
  assert.throws(() => addComment(dir, 'T-0001', '   '), ThreadError);
});

test('a proposal is decided once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-threads-'));
  const t = addComment(dir, 'T-0001', 'Split this');
  const p = addProposal(dir, t.key, 'The second half', { title: 'Second half of T-0001' });
  decide(dir, t.key, p.id, 'declined', 'not yet');
  assert.throws(() => decide(dir, t.key, p.id, 'accepted', ''), /already decided/);
  assert.equal(thread(dir, t.key)!.waitingOn, 'daniel', 'a decision does not count as Daniel speaking');
});

// ---- MCP ----

test('the MCP endpoint answers initialize, tools/list and tools/call, and accepts notifications', async () => {
  const root = controlPlane([{}]);
  const token = livePass(root, 'T-0001');
  const ctx = passFor([root], token)!;
  assert.equal(ctx.pass.task, 'T-0001');
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, BUILDER_TOOLS, ctx, BUILDER_SERVER);
  assert.equal((init.body as any).result.protocolVersion, '2025-06-18');
  assert.deepEqual((init.body as any).result.capabilities, { tools: { listChanged: false } });
  assert.equal((await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, BUILDER_TOOLS, ctx, BUILDER_SERVER)).status, 202);
  const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, BUILDER_TOOLS, ctx, BUILDER_SERVER);
  assert.deepEqual((list.body as any).result.tools.map((t: { name: string }) => t.name), ['report_progress', 'report_issue']);
  const call = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_issue', arguments: { kind: 'spec_question', message: 'Empty list?' } } }, BUILDER_TOOLS, ctx, BUILDER_SERVER);
  assert.equal((call.body as any).result.isError, undefined);
  const refused = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report_issue', arguments: { kind: 'opinion', message: 'x' } } }, BUILDER_TOOLS, ctx, BUILDER_SERVER);
  assert.equal((refused.body as any).result.isError, true);
  const unknown = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'release' } }, BUILDER_TOOLS, ctx, BUILDER_SERVER);
  assert.equal((unknown.body as any).error.code, -32602);
  const reports = readFileSync(paths(root).reports, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(reports.map((r) => [r.pass, r.kind, r.issue, r.message]), [['T-0001:claude:1', 'issue', 'spec_question', 'Empty list?']]);
});

test('a builder token works only while its pass is in flight', () => {
  const root = controlPlane([{}]);
  const token = livePass(root, 'T-0001');
  assert.ok(passFor([root], token));
  assert.equal(passFor([root], newToken()), undefined);
  writeFileSync(paths(root).live, JSON.stringify({ updatedAt: '', pid: 0, passes: [] }));
  assert.equal(passFor([root], token), undefined);
});

test('both adapters wire exactly the app\'s server into a pass, and none without one', () => {
  const config = loadConfig();
  const mcp = { url: 'http://127.0.0.1:47320/mcp/builder', token: 'tok' };
  const claude = claudeAdapter(config.agents.claude, config).invocation('build', '/w', 'p', mcp);
  const servers = JSON.parse(claude.args[claude.args.indexOf('--mcp-config') + 1]!).mcpServers;
  assert.deepEqual(Object.keys(servers), ['helix']);
  assert.equal(servers.helix.headers.Authorization, 'Bearer tok');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.ok(claude.args.includes('mcp__helix__report_progress') && claude.args.includes('mcp__helix__report_issue'));
  assert.ok(!claudeAdapter(config.agents.claude, config).invocation('build', '/w', 'p').args.includes('--mcp-config'));
  const codex = codexAdapter(config.agents.codex, config, '/codex-home').invocation('build', '/w', 'p', mcp);
  assert.ok(codex.args.includes(`mcp_servers.helix.url="${mcp.url}"`));
  assert.ok(codex.args.includes('mcp_servers.helix.default_tools_approval_mode="approve"'));
  assert.equal(codex.env?.HELIX_MCP_TOKEN, 'tok');
  assert.ok(codex.args.includes('--ignore-user-config'));
  assert.ok(!codexAdapter(config.agents.codex, config, '/h').invocation('build', '/w', 'p').args.some((a) => a.startsWith('mcp_servers')));
});

test('Helix resolves a thread only after it has answered, or when Daniel pressed Resolve', async () => {
  const root = controlPlane([{}]);
  const dir = paths(root).threads;
  const t = addComment(dir, 'T-0001', 'What does this build?');
  const job: HelixJob = { role: 'assistant', key: t.key, root, tokenHash: '', startedAt: '', resolved: false };
  const resolve = ASSISTANT_TOOLS.find((x) => x.name === 'resolve_thread')!;
  await assert.rejects(async () => resolve.call({ summary: 'Done.' }, { root, job }), /Not yet: answer Daniel first/);
  addMessage(dir, t.key, 'helix', 'It builds the thing.');
  await resolve.call({ summary: 'Explained what it builds.' }, { root, job });
  assert.equal(thread(dir, t.key)!.state, 'resolved');
  assert.equal(job.resolved, true);

  const second = addComment(dir, 'T-0001', 'Close this straight away');
  addMessage(dir, second.key, 'daniel', RESOLVE_REQUEST);
  await resolve.call({ summary: 'Closed at Daniel\'s request.' }, { root, job: { ...job, key: second.key } });
  assert.equal(thread(dir, second.key)!.state, 'resolved');
});

// ---- plan edits ----

test('a plan edit is refused for a task in a pass, for fields the editor may not change, and when the graph would break', async () => {
  const root = controlPlane([{}, { blocked_by: ['T-0001'] }, { status: 'claimed', claimed_by: 'codex' }]);
  const msg = { fields: STEWARD_TASK_FIELDS, message: 'Plan: test' };
  await assert.rejects(updateTask(root, 'T-0003', { notes: 'x' }, msg), /in a pass/);
  livePass(root, 'T-0001');
  await assert.rejects(updateTask(root, 'T-0001', { notes: 'x' }, msg), /in a pass/);
  writeFileSync(paths(root).live, JSON.stringify({ updatedAt: '', pid: 0, passes: [] }));
  await assert.rejects(updateTask(root, 'T-0001', { attempts: [] } as Partial<Task>, msg), /can't be changed here: attempts/);
  await assert.rejects(updateTask(root, 'T-0001', { status: 'done' }, msg), /only to ready or parked/);
  await assert.rejects(updateTask(root, 'T-0001', { blocked_by: ['T-0002'] }, msg), (e: unknown) => e instanceof PlanEditError && /would not validate/.test((e as Error).message));
  await assert.rejects(updateTask(root, 'T-0001', { blocked_by: ['T-9999'] }, msg), /would not validate/);
  await assert.rejects(updateTask(root, 'T-0001', { estimate_passes: 'many' as unknown as number }, msg), /schema/);
  assert.deepEqual(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0001')!.blocked_by, [], 'a refused edit leaves the file as it was');
});

test('an accepted edit is written, rendered and committed with a message that says who changed what', async () => {
  const root = controlPlane([{}, { status: 'needs_human' }], [{ id: 'HT-1', handoff_prompt: 'Line one.\nLine two.\n' }]);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root }).toString().trim();
  writeFileSync(join(root, '.gitignore'), 'runs/\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'control plane');
  const r = await updateTask(root, 'T-0002', { status: 'ready', notes: 'Use the shared helper.' }, { fields: ['status', 'notes'], message: 'Plan: T-0002 handed back to the loop (Daniel, in the loop app)' });
  assert.equal(r.committed, true);
  assert.equal(git('log', '-1', '--format=%s'), 'Plan: T-0002 handed back to the loop (Daniel, in the loop app)');
  assert.ok(git('show', '--name-only', '--format=', 'HEAD').split('\n').includes('plan/tasks/T-0002.yaml'));
  assert.equal(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0002')!.status, 'ready');

  await updateHuman(root, 'HT-1', { status: 'done', notes: 'Approved on 2026-10-25.' }, { fields: ['status', 'notes'], message: 'Plan: HT-1 done (Daniel, in the loop app)' });
  const human = readFileSync(join(paths(root).human, 'HT-1.yaml'), 'utf8');
  assert.match(human, /status: done/);
  assert.match(human, /handoff_prompt: \|\n {2}Line one\.\n {2}Line two\./, 'the block scalar is left as it was');

  const created = await createTask(root, { repo: 'mushy-docs', stage: 'day1', area: 'docs/new', title: 'A task the steward proposed and Daniel accepted', reqs: ['PB-14'], spec: ['PB-14'], acceptance: ['unit: [PB-14] the new docs page renders'], blocked_by: ['T-0001'], estimate_passes: 1 }, 'Plan: {id}: proposed (steward)');
  assert.equal(created.value.id, 'T-0003');
  assert.equal(git('log', '-1', '--format=%s'), 'Plan: T-0003: proposed (steward)');
});

// ---- sign-in ----

test('only a subscription sign-in may build', () => {
  assert.deepEqual(claudeSignIn('{"loggedIn": true, "authMethod": "claude.ai"}'), { subscription: true, method: 'subscription' });
  assert.equal(claudeSignIn('{"loggedIn": true, "authMethod": "api_key"}').method, 'API key');
  assert.equal(claudeSignIn('{"loggedIn": true, "authMethod": "console"}').method, 'Console');
  assert.equal(claudeSignIn('{"loggedIn": false}').method, 'signed out');
  assert.equal(claudeSignIn('not json').subscription, false);
  assert.equal(codexSignIn('Logged in using ChatGPT').subscription, true);
  assert.equal(codexSignIn('Logged in using an API key - sk-proj-***').method, 'API key');
  assert.equal(codexSignIn('Not logged in').method, 'signed out');
});

// ---- the server ----

test('the server answers only on 127.0.0.1, refuses changes without the launch token or from another origin, and streams changes', async () => {
  const root = controlPlane([{}, {}]);
  const app = await startApp({ root, port: 0 });
  try {
    const page = await (await fetch(`${app.url}/`)).text();
    const token = /name="helix-token" content="([^"]+)"/.exec(page)![1]!;
    assert.equal((await fetch(`${app.url}/health`)).status, 200);
    // fetch sets Host itself; a rebinding attacker's request carries its own name, as this one does.
    const evil = await new Promise<number>((resolve, reject) =>
      request(`${app.url}/api/state`, { headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject).end(),
    );
    assert.equal(evil, 421);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${app.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/comment', { target: 'T-0001', text: 'hi' })).status, 403);
    assert.equal((await post('/api/comment', { target: 'T-0001', text: 'hi' }, { 'x-helix-token': token, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/comment', { target: 'T-0404', text: 'hi' }, { 'x-helix-token': token })).status, 404);

    const state = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(state.totals.tasks, 2);
    assert.equal(state.loop.running, false);
    assert.equal((await fetch(`${app.url}/view/map`)).headers.get('content-type'), 'text/html; charset=utf-8');

    // A change to a task file reaches the page as one "changed" event naming the plan.
    const events = await fetch(`${app.url}/events`);
    const reader = events.body!.getReader();
    const seen = (async () => {
      let text = '';
      while (!text.includes('event: changed')) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    })();
    await new Promise((r) => setTimeout(r, 300));
    const r = await post('/api/task/action', { id: 'T-0002', action: 'park' }, { 'x-helix-token': token });
    assert.equal(r.status, 200, await r.clone().text());
    assert.match(await seen, /"what":\[[^\]]*"plan"/);
    await reader.cancel();
    assert.equal(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0002')!.status, 'parked');

    // MCP: no token, no pass.
    assert.equal((await post('/mcp/builder', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    const passToken = livePass(root, 'T-0001');
    const ok = await post('/mcp/builder', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_progress', arguments: { message: 'Writing the tests' } } }, { authorization: `Bearer ${passToken}` });
    assert.equal((await ok.json()).result.content[0].text, 'Shown on the map.');
    assert.equal((await fetch(`${app.url}/mcp/builder`)).status, 405);
  } finally {
    await app.close();
  }
});

test('notes are edited in place for tasks and human tasks, and refused for a task in a pass', async () => {
  const root = controlPlane([{}, {}], [{ id: 'HT-1', notes: 'Booked for Tuesday.' }]);
  const app = await startApp({ root, port: 0 });
  try {
    const token = /name="helix-token" content="([^"]+)"/.exec(await (await fetch(`${app.url}/`)).text())![1]!;
    const notes = (id: string, text: string) =>
      fetch(`${app.url}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-helix-token': token }, body: JSON.stringify({ id, notes: text }) });
    assert.equal((await notes('T-0001', '  Reuse the shared helper.  ')).status, 200);
    assert.equal((await notes('HT-1', 'Done on 2026-10-26; the receipt is in Drive.')).status, 200);
    const plan = () => loadPlan(paths(root).tasks, paths(root).human);
    assert.equal(plan().tasks.get('T-0001')!.notes, 'Reuse the shared helper.');
    assert.equal(plan().human.get('HT-1')!.notes, 'Done on 2026-10-26; the receipt is in Drive.');
    assert.equal((await notes('T-0001', '')).status, 200);
    assert.equal(plan().tasks.get('T-0001')!.notes, undefined, 'empty notes are removed, not written as ""');
    livePass(root, 'T-0002');
    const refused = await notes('T-0002', 'Too late');
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /in a pass/);
  } finally {
    await app.close();
  }
});

// ---- the agent view: passes in flight, slots and pace, and each pass's activity feed ----

const j = (o: unknown) => JSON.stringify(o);
const claudeCall = (id: string, name: string, input: unknown) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const claudeResult = (id: string, content: string, isError = false) => j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

test('a Claude Code pass log reads as what its builder did: setup, its words and calls settled by their results, its turn, then the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'mushy-feed-'));
  const wt = `${root}/worktrees/mushy-social-media/T-0001-claude`;
  const file = join(root, 'T-0001-claude-1.log');
  writeFileSync(file, [
    'Packages: +849', 'Done in 24.8s',
    j({ type: 'system', subtype: 'init' }),
    j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the failing test first.' }] } }),
    claudeCall('t1', 'Read', { file_path: `${wt}/e2e/a.test.ts` }),
    claudeCall('t2', 'Grep', { pattern: 'NIS-8', path: `${wt}/e2e` }),
    claudeResult('t1', 'x'),
    claudeCall('t3', 'Bash', { command: 'pnpm e2e e2e/a.test.ts', description: 'Run the browser test' }),
    claudeResult('t3', 'Exit code 1\n1 failed', true),
    claudeCall('t4', 'Edit', { file_path: `${wt}/e2e/a.test.ts`, old_string: 'a', new_string: 'b' }),
    claudeCall('t5', 'mcp__mushy__report_progress', { message: 'Fixing the drawer wait' }),
    claudeCall('t6', 'Bash', { command: 'pnpm lint' }),
    '',
  ].join('\n'));
  let feed = readFeed(file, 'claude', root)!;
  assert.deepEqual(feed.items.map((i) => [i.kind, i.state ?? '']), [['output', ''], ['message', ''], ['look', ''], ['command', 'failed'], ['edit', 'running'], ['report', 'running'], ['command', 'running']]);
  assert.equal(feed.items[0]!.text, 'Setting up · 2 lines');
  assert.equal(feed.items[2]!.text, 'Read e2e/a.test.ts, searched 1 time', 'a run of reads and searches is one item, with paths as the repo names them');
  assert.equal(feed.items[3]!.note, 'Run the browser test');
  assert.match(feed.items[3]!.detail!, /1 failed/);
  assert.deepEqual(feed.summary, { toolCalls: 6, commands: 2, failed: 1, files: 1 });
  assert.equal(feed.phase, 'agent');
  const keys = feed.items.map((i) => i.key);
  const lint = feed.items.at(-1)!;

  // The log grows: only the new part is read; known items keep their keys and settle in place.
  writeFileSync(file, [
    claudeResult('t6', 'ok'),
    j({ total_cost_usd: 1.2, type: 'result', subtype: 'success', is_error: false, result: 'T-0001: wait for the drawer' }),
    '> gate 15-lint: pnpm lint', '> gate 70-unit: pnpm test:unit', 'lint output', '< gate 15-lint: passed in 31.2s', '< gate 70-unit: failed in 12s (exit 1)', 'Gate failed at 70-unit (exit 1)', '',
  ].join('\n'), { flag: 'a' });
  feed = readFeed(file, 'claude', root)!;
  assert.deepEqual(feed.items.slice(0, keys.length).map((i) => i.key), keys);
  const settled = feed.items.find((i) => i.key === lint.key)!;
  assert.equal(settled.state, 'ok');
  assert.ok(settled.v > lint.v, 'a changed item says so, for the page to redraw it');
  assert.deepEqual(feed.items.slice(-2).map((i) => i.kind), ['done', 'gate']);
  const gate = feed.items.at(-1)!;
  assert.deepEqual(gate.steps, [{ step: '15-lint', state: 'ok', ms: 31200 }, { step: '70-unit', state: 'failed', ms: 12000 }]);
  assert.equal(gate.state, 'failed');
  assert.equal(gate.text, 'Gate: 1 of 2 steps passed · 70-unit failed');
  assert.equal(feed.phase, 'gate');
  assert.ok(feed.done);
});

test('a Codex pass log: an item settles where it started, its shell wrapper is taken off, and its words carry no state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mushy-feed-'));
  const file = join(root, 'T-0002-codex-1.log');
  writeFileSync(file, [
    j({ type: 'thread.started', thread_id: 'x' }),
    j({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Inspecting the gate failures.' } }),
    j({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'pnpm test:integration'", status: 'in_progress' } }),
    j({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: `${root}/worktrees/r/T-0002-codex/a.ts`, kind: 'update' }, { path: `${root}/worktrees/r/T-0002-codex/b.ts`, kind: 'add' }], status: 'completed' } }),
    j({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'pnpm test:integration'", aggregated_output: 'FAIL a.test.ts\n', exit_code: 1, status: 'failed' } }),
    j({ level: 30, msg: 'a test logging JSON in the gate' }),
    '',
  ].join('\n'));
  const feed = readFeed(file, 'codex', root)!;
  assert.deepEqual(feed.items.map((i) => [i.kind, i.state ?? '', i.text]), [
    ['message', '', 'Inspecting the gate failures.'],
    ['command', 'failed', 'pnpm test:integration'],
    ['edit', 'ok', 'Edited 2 files'],
    ['output', '', 'Output · 1 line'],
  ]);
  assert.equal(feed.items[2]!.detail, 'update a.ts\nadd b.ts');
  assert.deepEqual(feed.summary, { toolCalls: 2, commands: 1, failed: 1, files: 2 });
  assert.equal(unwrapShell(`/bin/zsh -lc "rg -n 'x' \\"y\\""`), `rg -n 'x' "y"`);
  assert.equal(describeClaude('{"type":"rate_limit_event"}')?.length, 0, 'a known event with nothing to show is not output');
});

test('a loop that writes no runs/live.json still shows its passes, from the plan\'s claims and their logs', () => {
  const root = controlPlane([{ status: 'claimed', claimed_by: 'codex', title: 'Deliver notifications' }, { status: 'claimed', claimed_by: 'codex' }, {}]);
  const p = paths(root);
  writeFileSync(p.lock, String(process.pid));
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(join(p.logs, day), { recursive: true });
  writeFileSync(join(p.logs, day, 'T-0001-codex-1.log'), [j({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Running the suite.' } }), j({ type: 'turn.completed' }), '> gate 15-lint: pnpm lint', ''].join('\n'));
  const plan = loadPlan(p.tasks, p.human);
  const status = loopStatus(root, []);
  const passes = passesNow(root, plan, status);
  assert.deepEqual(passes.map((x) => [x.task, x.agent, x.phase, x.inferred, x.lastMessage, x.log]), [
    ['T-0001', 'codex', 'gate', true, 'Running the suite.', join('runs', 'logs', day, 'T-0001-codex-1.log')],
    ['T-0002', 'codex', 'setup', true, undefined, undefined],
  ]);
  const map = mapModel(root, plan, [], loadConfig(root));
  const codex = map.agents.find((a) => a.name === 'codex')!;
  assert.deepEqual(codex.tasks, ['T-0001', 'T-0002'], 'every pass an agent runs is on the map, not only its first');
  assert.equal(codex.state, 'busy');

  // A loop that writes runs/live.json is believed instead, once it is the one running.
  const live: LiveFile = { updatedAt: new Date().toISOString(), pid: process.pid, passes: [{ id: 'T-0003:claude:1', task: 'T-0003', repo: 'mushy-social-media', agent: 'claude', attempt: 1, startedAt: new Date().toISOString(), phase: 'agent', phaseAt: new Date().toISOString(), toolCalls: 4 }] };
  writeFileSync(p.live, j(live));
  assert.deepEqual(passesNow(root, plan, status).map((x) => [x.task, x.inferred ?? false]), [['T-0003', false]]);
});

test('the map shows each agent\'s slots, and fewer while its weekly pace holds it back', () => {
  const config = loadConfig();
  config.agents.codex.slots = 2;
  config.agents.codex.weekly_target = 0.9;
  const now = Date.UTC(2026, 9, 26, 12);
  const quota = loadQuota(join(mkdtempSync(join(tmpdir(), 'mushy-q-')), 'agents.json'), now);
  // Half the week gone, 45% allowed: 46% used is within the margin, so one pass at a time.
  quota.codex.usage = { at: now, weekly: { used: 0.46, resetsAt: now + 3.5 * 86_400_000 } };
  const [, codex] = mapAgents(config, quota, [{ agent: 'codex', task: 'T-0001' }], now);
  assert.deepEqual([codex!.tasks, codex!.slots, codex!.paced, codex!.pacedUntil], [['T-0001'], 2, 1, undefined]);
  quota.codex.usage = { at: now, weekly: { used: 0.7, resetsAt: now + 3.5 * 86_400_000 } };
  const [, ahead] = mapAgents(config, quota, [], now);
  assert.equal(ahead!.paced, 0);
  assert.ok(Date.parse(ahead!.pacedUntil!) > now);
  quota.codex.usage = undefined;
  assert.equal(mapAgents(config, quota, [], now)[1]!.paced, undefined);
});

test('the feed and agent endpoints serve only pass logs, and say what an agent did today', async () => {
  const root = controlPlane([{}]);
  const p = paths(root);
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(join(p.logs, day), { recursive: true });
  const rel = join('runs', 'logs', day, 'T-0001-claude-1.log');
  writeFileSync(join(root, rel), `${j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }] } })}\n`);
  writeFileSync(p.ledger, `${j({ kind: 'pass', at: new Date().toISOString(), task: 'T-0001', repo: 'mushy-social-media', agent: 'claude', model: 'm', attempt: 1, outcome: 'gate_failed', durationMs: 60_000, costUsd: 1.5, tokens: { input: 0, cachedInput: 0, output: 0 }, log: `${rel}.gz`, failing: '|unit| a > b' })}\n`);
  const app = await startApp({ root, port: 0 });
  try {
    const feed = await (await fetch(`${app.url}/api/feed?path=${encodeURIComponent(rel)}`)).json();
    assert.deepEqual(feed.items.map((i: { text: string }) => i.text), ['Hello.']);
    assert.equal(feed.finished, false);
    assert.equal((await fetch(`${app.url}/api/feed?path=${encodeURIComponent('harness/config.yaml')}`)).status, 400);
    assert.equal((await fetch(`${app.url}/api/feed?path=${encodeURIComponent('runs/logs/../../x.log')}`)).status, 400);
    const agent = await (await fetch(`${app.url}/api/agent?name=claude`)).json();
    assert.deepEqual(agent.today.map((t: { task: string; outcome: string; title: string }) => [t.task, t.outcome, t.title]), [['T-0001', 'gate_failed', 'App test task T-0001']]);
    assert.equal((await fetch(`${app.url}/api/agent?name=gpt`)).status, 400);
  } finally {
    await app.close();
  }
});
