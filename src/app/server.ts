import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { ownerOf } from './prompts.ts';
import { asset, BIN, configPath, logFile, FEEDBACK_KINDS, HELIX_DIR, loadConfig, MONITOR_LEVELS, monitorOf, PACKAGE_ROOT, paths, projectInfo, type Config, type FeedbackKind } from '../config.ts';
import { git } from '../git.ts';
import { renderDependencyMap } from '../map/render.ts';
import { renderMetrics } from '../metrics/render.ts';
import { run } from '../proc.ts';
import { pendingApprovals } from '../release.ts';
import { installSkill, packSkill, skillInfo } from '../skill.ts';
import { AGENTS, type AgentName, type HumanTask } from '../types.ts';
import { localDay } from '../agents/quota.ts';
import type { LedgerEvent } from '../ledger.ts';
import { commit, createTask, PlanEditError, runningTasks, updateHuman, updateTask } from './actions.ts';
import { finishMoved } from './board.ts';
import { undoChange } from './changes.ts';
import { applyChangeSet, applyToText, checkConfig, CONTROLS, ConfigEditError, configFile, effects, GROUPS, getValue, type ChangeSet } from './config.ts';
import { readFeed } from './feed.ts';
import { addClarification, applyChanges, withNote } from './fixes.ts';
import { deleteKey, forget, health, INSTALL, saveKey, SIGN_IN } from './health.ts';
import { ASSISTANT_TOOLS, Helix, HELIX_SERVER, monitorSpentToday, monitorTools, readReads, RESOLVE_REQUEST, type HelixRole } from './helix.ts';
import { appendHitl, DEFAULT_FEEDBACK, FEEDBACK_LABELS, feedbackRule, pilotOf, readHitl, readRules, REQUESTS, tableOf, writeRules, type Rule } from './hitl.ts';
import { appendStored, type PlanChange } from './incidents.ts';
import { Jobs, type Job } from './jobs.ts';
import { BUILDER_SERVER, BUILDER_TOOLS, handleRpc, passFor } from './mcp.ts';
import { estimateLevels, monitorChanges, monitorShouldRun, monitorTurnCosts } from './monitor.ts';
import { listPrompts, monitorPromptName, resetPrompt, savePrompt } from './prompts.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { appState, loopStatus, mapModel, metricsModel, readReports, snapshot, type Snapshot } from './state.ts';
import { readTaskSetFile } from './taskset.ts';
import { loadPlan } from '../plan/store.ts';
import { addComment, addMessage, addReply, allThreads, decide, isTarget, newConversationTarget, readEntries, thread, threadsOf, ThreadError } from './threads.ts';
import { builderHistory, buildView, helixSummary, mergeBuckets, pilotView, resolvedRecord, taskCommits, welcome, type View } from './views.ts';

// `helix-loop app` (spec §4): one local process serving one live page, its JSON API and change stream, and the
// MCP endpoints for builders and Helix. It shares only files with the loop, so either can restart without the
// other. It binds 127.0.0.1 only and refuses any other Host (DNS rebinding); every request that changes
// something carries the launch token the page was served with, and no foreign Origin.

const exec = promisify(execFile);
const PAGE = asset('src', 'app', 'page');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain' };

type Which = 'real' | 'dry';

export interface App {
  url: string;
  close: () => Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function startApp(opts: { root: string; port: number; open?: boolean }): Promise<App> {
  const roots: Record<Which, string> = { real: opts.root, dry: paths(opts.root).dryRun };
  const settingsFile = paths(opts.root).appSettings;
  // Who the app acts for, in commit messages and records: the project's owner.
  const OWNER = () => ownerOf(roots.real);
  const launchToken = randomBytes(24).toString('base64url');
  let port = opts.port;

  // ---- cached reads, dropped when their files change ----
  const snaps = new Map<Which, Snapshot>();
  const views = new Map<Which, View>();
  // The dry run's own config once it exists; before its first start, the real one stands in.
  const configOf = (w: Which) => {
    try {
      return loadConfig(roots[w]);
    } catch (e) {
      if (w === 'dry') return loadConfig(roots.real);
      throw e;
    }
  };
  const snap = (w: Which) => {
    let s = snaps.get(w);
    if (!s) snaps.set(w, (s = snapshot(roots[w])));
    return s;
  };
  const dismissed = () => new Set(loadSettings(settingsFile).dismissed);
  const view = (w: Which) => {
    let v = views.get(w);
    // A view is at most a minute old even when nothing changed: the projection moves with the clock.
    if (!v || Date.now() - v.at > 60_000) views.set(w, (v = buildView(roots[w], snap(w), configOf(w), { dismissed: dismissed() })));
    return v;
  };

  // ---- the change stream ----
  const clients = new Set<ServerResponse>();
  const passClients = new Map<ServerResponse, { which: Which; log: string }>();
  const send = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const pending: Record<Which, Set<string>> = { real: new Set(), dry: new Set() };
  let flush: NodeJS.Timeout | undefined;
  let closed = false;
  const changed = (w: Which, what: string) => {
    if (closed) return;
    if (what === 'plan' || what === 'ledger') snaps.delete(w);
    if (what === 'plan') void flushNotes(w);
    if (['plan', 'ledger', 'reports', 'incidents', 'hitl', 'live', 'settings', 'config', 'approvals', 'loop'].includes(what)) views.delete(w);
    pending[w].add(what);
    flush ??= setTimeout(() => {
      flush = undefined;
      for (const k of ['real', 'dry'] as Which[]) {
        if (pending[k].size) send('changed', { root: k, what: [...pending[k]] });
        pending[k].clear();
      }
    }, 300);
    // A config change too, so a monitor just turned on starts from what is there.
    if (w === 'real' && ['reports', 'ledger', 'config'].includes(what)) monitorConsider();
  };
  const heartbeat = setInterval(() => {
    for (const c of [...clients, ...passClients.keys()]) c.write(': keep-alive\n\n');
  }, 25_000);

  const jobs = new Jobs((job) => send('job', job));
  const helixAgent = (role: HelixRole): AgentName => {
    const s = loadSettings(settingsFile).helix;
    return (role === 'monitor' ? (s?.monitor ?? loadConfig(roots.real).helix?.monitor?.agent) : s?.assistant) ?? 'claude';
  };
  const helix = new Helix({
    port: () => port,
    agent: helixAgent,
    config: () => loadConfig(roots.real),
    onChange: () => send('helix', helix.status()),
  });

  // The monitor (spec §9.1): after the passes and reports its level looks at (monitor.ts), at most once a minute,
  // and on the level's heartbeat while the loop runs; only when the owner turned it on and its own daily cap isn't
  // spent.
  let monitorTimer: NodeJS.Timeout | undefined;
  let monitorAt = 0;
  const monitorNow = () => {
    try {
      return monitorOf(loadConfig(roots.real));
    } catch {
      return undefined; // a config being rewritten, or a control plane that has gone
    }
  };
  const monitorOn = () => {
    const m = monitorNow();
    if (!m?.enabled) return false;
    return monitorSpentToday(paths(roots.real).helixTurns, localDay(Date.now()), localDay) < m.budgetUsd;
  };
  // What the monitor has seen of the ledger and the reports: only what is new since can start a turn. While it is
  // off nothing is read, and it starts from what is there when it comes on.
  let seen: { events: number; reports: number } | undefined;
  const monitorConsider = () => {
    const m = monitorNow();
    if (!m?.enabled) return void (seen = undefined);
    const events = snap('real').events;
    const reports = readReports(roots.real);
    // A file that shrank was rotated or replaced: start again from its end.
    const from = seen && events.length >= seen.events && reports.length >= seen.reports ? seen : { events: events.length, reports: reports.length };
    seen = { events: events.length, reports: reports.length };
    if (monitorChanges(events, reports, from).some((c) => monitorShouldRun(m.level, c.change))) monitorSoon();
  };
  const monitorSoon = () => {
    if (monitorTimer || !monitorOn()) return;
    monitorTimer = setTimeout(() => {
      monitorTimer = undefined;
      monitorAt = Date.now();
      helix.watch(roots.real);
    }, Math.max(5_000, monitorAt + 60_000 - Date.now()));
  };
  const monitorTick = setInterval(() => {
    if (!monitorOn()) return;
    const minutes = monitorNow()?.everyMinutes;
    if (minutes && Date.now() - monitorAt >= minutes * 60_000 && loopStatus(roots.real, snap('real').events).running) monitorSoon();
  }, 60_000);
  monitorConsider(); // a monitor already on starts from what is there

  // Builder logs are written many times a second: the page hears of them at most every two seconds, and a
  // page watching one pass gets that pass's feed as it grows (spec §6.5).
  const logsAt: Record<Which, number> = { real: 0, dry: 0 };
  const logsTimers: Partial<Record<Which, NodeJS.Timeout>> = {};
  const logsChanged = (w: Which, rel: string) => {
    for (const [res, sub] of passClients) if (sub.which === w && (sub.log === rel || `${sub.log}.gz` === rel)) pushFeed(res, sub);
    logsTimers[w] ??= setTimeout(() => {
      logsTimers[w] = undefined;
      logsAt[w] = Date.now();
      changed(w, 'logs');
    }, Math.max(0, logsAt[w] + 2000 - Date.now()));
  };
  const feedSent = new Map<ServerResponse, string>();
  function pushFeed(res: ServerResponse, sub: { which: Which; log: string }): void {
    const root = roots[sub.which];
    const file = [logFile(root, sub.log), logFile(root, `${sub.log}.gz`)].find((f) => existsSync(f));
    const agent = /-(claude|codex)-\d+\.log/.exec(sub.log)?.[1] as AgentName | undefined;
    if (!file || !agent) return;
    const feed = readFeed(file, agent, root, 400);
    if (!feed) return;
    const stamp = `${feed.updatedAt}:${feed.items.length}:${file.endsWith('.gz')}`;
    if (feedSent.get(res) === stamp) return;
    feedSent.set(res, stamp);
    res.write(`event: feed\ndata: ${JSON.stringify({ ...feed, finished: file.endsWith('.gz') })}\n\n`);
  }

  // ---- watching the project: .helix/'s plan, runs, config and Helix's files ----
  // Each folder on its own: the product repos and the passes' worktrees in .helix/ change too often to watch.
  const watchers: FSWatcher[] = [];
  const DRY = join('runs', 'dry-run', HELIX_DIR);
  const classify = (rel: string): [Which, string] | undefined => {
    let w: Which = 'real';
    if (rel.startsWith(DRY + sep)) {
      w = 'dry';
      rel = rel.slice(DRY.length + 1);
    }
    const parts = rel.split(sep);
    const [a, b] = parts;
    if (a === 'plan' && (b === 'tasks' || b === 'human' || b === 'taskset.yaml')) return [w, 'plan'];
    if (a === 'config.yaml' || a === 'helix') return [w, 'config'];
    if (a === 'app.yaml') return w === 'real' ? [w, 'settings'] : undefined;
    if (a !== 'runs') return undefined;
    const name = parts.at(-1)!;
    if (b === 'threads') return [w, 'threads'];
    if (b === 'approvals') return [w, 'approvals'];
    if (b === 'logs' && parts.length === 4 && /\.log(\.gz)?$/.test(name)) return [w, 'logs'];
    if (parts.length !== 2) return undefined;
    if (name === 'runs.jsonl') return [w, 'ledger'];
    if (name === 'agents.json') return [w, 'agents'];
    if (name === 'live.json') return [w, 'live'];
    if (name === 'reports.jsonl') return [w, 'reports'];
    if (name === 'incidents.jsonl' || name === 'helix-reads.jsonl') return [w, 'incidents'];
    if (name === 'hitl.jsonl') return [w, 'hitl'];
    if (name === 'changes.jsonl') return [w, 'changes'];
    if (name === 'steward.jsonl' || name === 'helix.jsonl') return [w, 'agents'];
    if (name === 'loop.lock' || name === 'STOP' || name === 'PAUSE') return [w, 'loop'];
    return undefined;
  };
  const home = paths(opts.root).home;
  for (const dir of ['plan', 'runs', 'helix', '']) {
    mkdirSync(join(home, dir), { recursive: true });
    const w = watch(join(home, dir), { recursive: dir !== '' }, (_e, file) => {
      if (!file) return;
      const rel = join(dir, file.toString());
      const c = classify(rel);
      if (c?.[1] === 'logs') logsChanged(c[0], c[0] === 'dry' ? relative(DRY, rel) : rel);
      else if (c) changed(...c);
    });
    w.on('error', () => undefined);
    watchers.push(w);
  }

  // ---- requests ----
  const host = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const sameOrigin = (o: string | undefined) => !o || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const tokenOk = (got: string | undefined, want: string) => !!got && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      const status = e instanceof HttpError ? e.status : e instanceof PlanEditError || e instanceof ThreadError || e instanceof ConfigEditError ? 409 : 500;
      if (status === 500) console.error(e.stack ?? e);
      if (!res.headersSent) reply(res, status, { error: e.message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!host(req.headers.host)) throw new HttpError(421, 'this app answers only on 127.0.0.1');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const q = url.searchParams;
    const which: Which = q.get('root') === 'dry' ? 'dry' : 'real';
    const root = roots[which];
    const path = url.pathname;

    // MCP: builders and Helix, each with its own bearer token. Helix's token carries its role, so the assistant
    // can't call the monitor's tools or the other way round.
    if (path === '/mcp/builder' || path === '/mcp/helix') {
      if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
      if (!sameOrigin(req.headers.origin)) throw new HttpError(403, 'foreign origin');
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const body = await readJson(req);
      if (path === '/mcp/builder') {
        const ctx = passFor([roots.real, roots.dry], bearer);
        if (!ctx) throw new HttpError(401, 'no pass in flight has this token');
        const r = await handleRpc(body, BUILDER_TOOLS, ctx, BUILDER_SERVER);
        if (ctx.root === roots.real) onFeedback(ctx.pass.task);
        return rpcReply(res, r);
      }
      const job = helix.jobFor(bearer);
      if (!job) throw new HttpError(401, 'no Helix turn in flight has this token');
      return rpcReply(res, await handleRpc(body, job.role === 'monitor' ? monitorTools(loadConfig(roots.real)) : ASSISTANT_TOOLS, { root: job.root, job }, HELIX_SERVER));
    }

    if (req.method === 'GET') {
      if (path === '/health') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      if (path === '/') {
        const page = readFileSync(join(PAGE, 'index.html'), 'utf8').replace('{{TOKEN}}', launchToken);
        return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
      }
      // The page's own files: scripts, styles, fonts.
      if (/^\/[\w-]+\.(js|css)$/.test(path) || /^\/fonts\/[\w.-]+\.(woff2|txt)$/.test(path)) {
        const file = join(PAGE, normalize(path));
        if (!file.startsWith(PAGE) || !existsSync(file)) throw new HttpError(404, 'not found');
        const type = TYPES[extname(file)] ?? 'application/octet-stream';
        return void res.writeHead(200, { 'content-type': `${type}${type.startsWith('text') ? '; charset=utf-8' : ''}`, 'cache-control': path.startsWith('/fonts/') ? 'max-age=86400' : 'no-store' }).end(readFileSync(file));
      }
      if (path === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: {}\n\n`);
        // One pass's feed, as its builder writes it, or the page's change stream.
        const log = q.get('pass');
        if (log) {
          const sub = { which, log: logPath(log) };
          passClients.set(res, sub);
          req.on('close', () => {
            passClients.delete(res);
            feedSent.delete(res);
          });
          return pushFeed(res, sub);
        }
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      const config = configOf(which);
      if (path === '/view/map') return html(res, renderDependencyMap(mapModel(root, snap(which).plan, snap(which).events, config)));
      // The metrics page loads its version list beside it; served from runs/metrics/ when there is one.
      if (path === '/view/versions.js') {
        const f = join(paths(root).metrics, 'versions.js');
        return void res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(existsSync(f) ? readFileSync(f) : '');
      }
      if (path === '/view/metrics') return html(res, renderMetrics(metricsModel(root, snap(which).plan, snap(which).events, config)));
      if (path === '/api/metrics') return reply(res, 200, metricsModel(root, snap(which).plan, snap(which).events, config));
      if (path === '/api/state') {
        // File events can come late under load: each look at the state also lands notes whose pass has ended.
        await flushNotes(which);
        return reply(res, 200, stateOf(which));
      }
      if (path === '/api/home') {
        const v = view(which);
        const s = loadSettings(settingsFile);
        return reply(res, 200, { groups: v.groups, welcome: which === 'real' ? welcome(v, s.lastHome) : undefined, finish: v.board.finish, codeFinish: v.board.codeFinish, timelines: v.board.timelines });
      }
      if (path === '/api/board') {
        const { projection: _p, rank: _r, ...board } = view(which).board as View['board'] & { projection?: unknown };
        return reply(res, 200, board);
      }
      if (path === '/api/health') return reply(res, 200, await health(loadConfig(roots.real), { refresh: q.get('refresh') === '1' }));
      if (path === '/api/task') return reply(res, 200, await taskDetail(which, q.get('id') ?? ''));
      if (path === '/api/group') return reply(res, 200, await groupDetail(which, q.get('id') ?? ''));
      if (path === '/api/thread') {
        const t = thread(paths(root).threads, q.get('key') ?? '');
        if (!t) throw new HttpError(404, 'no such thread');
        return reply(res, 200, t);
      }
      if (path === '/api/log') return text(res, readLog(root, q.get('path') ?? ''));
      if (path === '/api/feed') {
        const rel = logPath(q.get('path') ?? '');
        const agent = /-(claude|codex)-\d+\.log(\.gz)?$/.exec(rel)?.[1] as AgentName | undefined;
        if (!agent) throw new HttpError(400, 'not a pass log');
        // A pass that just ended has had its log compressed.
        const file = [logFile(root, rel), logFile(root, `${rel}.gz`)].find((f) => existsSync(f));
        const feed = file && readFeed(file, agent, root, Number(q.get('limit')) || 400);
        if (!feed) throw new HttpError(404, 'that log is gone');
        return reply(res, 200, { ...feed, finished: file!.endsWith('.gz') });
      }
      if (path === '/api/agent') return reply(res, 200, agentDetail(which, q.get('name') ?? ''));
      if (path === '/api/commit') return text(res, await commitDiff(root, q.get('repo') ?? '', q.get('sha') ?? ''));
      if (path === '/api/release') return reply(res, 200, await releaseFiles(root, q.get('repo') ?? '', q.get('tag') ?? ''));
      if (path === '/api/release/file') return text(res, await releaseFileDiff(root, q.get('repo') ?? '', q.get('tag') ?? '', q.get('file') ?? ''));
      if (path === '/api/helix') {
        const v = view(which);
        const s = loadSettings(settingsFile);
        return reply(res, 200, {
          ...helixSummary(v),
          resolved: resolvedRecord(v, q.get('since') ?? undefined),
          lastHome: s.lastHome?.at,
          conversations: allThreads(paths(root).threads).map((t) => ({ key: t.key, target: t.target, state: t.state, waitingOn: t.waitingOn, first: t.root.text.split('\n')[0]!.slice(0, 160), at: (t.messages.at(-1) ?? t.root).at, busy: helix.status().busy === t.key })),
          raised: readHitl(paths(root).hitl).raised.filter((r) => !r.answered),
          status: helix.status(),
        });
      }
      if (path === '/api/settings') return reply(res, 200, settingsOf(which));
      if (path === '/api/skill/file') {
        const name = q.get('name') ?? '';
        if (!/^[\w-]+(\/[\w.-]+)*\.md$/.test(name)) throw new HttpError(400, 'a Markdown file of the skill');
        const f = asset('skill', name);
        if (!existsSync(f)) throw new HttpError(404, 'not in the skill');
        return text(res, readFileSync(f, 'utf8'));
      }
      throw new HttpError(404, 'not found');
    }

    if (req.method !== 'POST') throw new HttpError(405, 'GET or POST');
    if (!sameOrigin(req.headers.origin)) throw new HttpError(403, 'foreign origin');
    if (!tokenOk(req.headers['x-helix-token'] as string | undefined, launchToken)) throw new HttpError(403, 'reload the page: its launch token is out of date');
    const body = (await readJson(req)) as Record<string, any>;
    const dir = paths(root).threads;
    // A change that builds on what a task says now reads it from disk: the cache follows file events, which can
    // arrive after a second request that came straight after the first.
    const fresh = () => loadPlan(paths(root).tasks, paths(root).human);
    switch (path) {
      // ---- the loop ----
      case '/api/loop/start':
        return reply(res, 200, await startLoop(which, body));
      case '/api/loop/stop': {
        if (!loopStatus(root, snap(which).events).running) throw new HttpError(409, 'the loop is not running');
        mkdirSync(paths(root).runs, { recursive: true });
        writeFileSync(paths(root).stopFile, '');
        changed(which, 'loop');
        return reply(res, 200, { stopping: true });
      }
      case '/api/loop/pause': {
        mkdirSync(paths(root).runs, { recursive: true });
        if (body.paused) writeFileSync(paths(root).pause, `paused by ${OWNER()}, in Helix Loop\n`);
        else rmSync(paths(root).pause, { force: true });
        changed(which, 'loop');
        return reply(res, 200, { paused: !!body.paused });
      }
      case '/api/pass/stop': {
        const task = String(body.task ?? '');
        if (!runningTasks(root, snap(which).plan).has(task)) throw new HttpError(409, `${task} has no pass in flight`);
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : undefined;
        writeStopRequest(root, task, { to: body.to === 'needs_human' ? 'needs_human' : 'ready', ...(note ? { note } : {}), why: `stopped by ${OWNER()} in Live` });
        return reply(res, 200, { stopping: task });
      }

      // ---- the plan: one task, or a batch ----
      case '/api/task/action': {
        const id = String(body.id ?? '');
        const t = fresh().tasks.get(id);
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
        if (body.action === 'hand_back' || body.action === 'park') {
          const patch = { status: body.action === 'hand_back' ? ('ready' as const) : ('parked' as const), ...(note ? { notes: withNote(t, note) } : {}) };
          return reply(res, 200, await updateTask(root, id, patch, { fields: ['status', 'notes'], message: `Plan: ${id} ${body.action === 'hand_back' ? 'handed back to the loop' : 'parked'} (${OWNER()}, in Helix Loop)` }));
        }
        if (body.action === 'add_dep' || body.action === 'remove_dep') {
          const on = String(body.on ?? '');
          return reply(res, 200, await applyChanges(root, [{ op: body.action, task: id, on }], { what: `${id} ${body.action === 'add_dep' ? 'waits on' : 'no longer waits on'} ${on}`, by: OWNER() }));
        }
        throw new HttpError(400, 'action is hand_back, park, add_dep or remove_dep');
      }
      case '/api/batch': {
        const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 2000) : [];
        if (!ids.length) throw new HttpError(400, 'select at least one task');
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
        const op = body.action === 'park' ? 'park' : body.action === 'hand_back' ? 'hand_back' : undefined;
        if (!op) throw new HttpError(400, 'action is hand_back or park');
        const changes: PlanChange[] = ids.filter((id) => snap(which).plan.tasks.has(id)).map((task) => ({ op, task, note }));
        return reply(res, 200, await applyChanges(root, changes, { what: `${op === 'park' ? 'park' : 'hand back'} ${changes.length} task${changes.length === 1 ? '' : 's'}`, by: OWNER(), source: typeof body.group === 'string' ? `group ${body.group.slice(0, 80)}` : undefined }));
      }
      case '/api/undo':
        return reply(res, 200, await undoChange(root, String(body.id ?? '')));
      case '/api/note-next': {
        // Note for next attempt (spec §6.5): into the task's notes now, or, while its pass runs and the loop holds
        // the task, as soon as the pass ends.
        const task = String(body.task ?? '');
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
        if (!note) throw new HttpError(400, 'write the note first');
        const plan = fresh();
        if (!plan.tasks.has(task)) throw new HttpError(404, `no task ${task}`);
        if (runningTasks(root, plan).has(task)) {
          mkdirSync(paths(root).runs, { recursive: true });
          appendFileSync(pendingNotes(root), `${JSON.stringify({ at: new Date().toISOString(), task, note })}\n`);
          return reply(res, 200, { pending: true });
        }
        return reply(res, 200, await updateTask(root, task, { notes: withNote(plan.tasks.get(task), note) }, { fields: ['notes'], message: `Plan: ${task} note for its next attempt (${OWNER()}, in Helix Loop)` }));
      }
      case '/api/notes': {
        // A task's notes (its next builder reads them in its prompt) or a human task's, edited in place.
        const id = String(body.id ?? '');
        const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
        if (notes.length > 6000) throw new HttpError(400, 'notes are at most 6,000 characters');
        const message = `Plan: ${id} notes ${notes ? 'updated' : 'cleared'} (${OWNER()}, in Helix Loop)`;
        const r = id.startsWith('HT-') ? await updateHuman(root, id, { notes }, { fields: ['notes'], message }) : await updateTask(root, id, { notes }, { fields: ['notes'], message });
        return reply(res, 200, r);
      }
      case '/api/human/action':
        return reply(res, 200, await humanAction(which, body));

      // ---- Home's screens ----
      case '/api/fix': {
        const key = String(body.key ?? '');
        const inc = view(which).incidents.find((i) => i.key === key);
        if (!inc?.fix) throw new HttpError(404, 'no fix waiting for that incident');
        if (body.decision === 'declined') {
          appendStored(paths(root).incidents, { type: 'decided', key, at: new Date().toISOString(), fix: inc.fix.id, decision: 'declined' });
          changed(which, 'incidents');
          return reply(res, 200, { declined: inc.fix.id });
        }
        // Try in dry run: a fresh dry run of the plan as it stands, with this fix applied to it.
        if (body.decision === 'dry') return reply(res, 200, await startLoop('dry', { agents: AGENTS, planChanges: inc.fix.changes }));
        if (body.decision === 'revise') {
          if (!monitorOn()) throw new HttpError(409, "Helix's monitor is off: turn it on in Settings › Helix");
          helix.watch(root, key);
          return reply(res, 200, { revising: key });
        }
        const r = await applyChanges(root, inc.fix.changes, { what: inc.fix.summary, by: OWNER(), source: `fix ${inc.fix.id}` });
        appendStored(paths(root).incidents, { type: 'decided', key, at: new Date().toISOString(), fix: inc.fix.id, decision: 'accepted', change: r.change?.id });
        changed(which, 'incidents');
        return reply(res, 200, r);
      }
      case '/api/answer':
        return reply(res, 200, await answerOnce(which, body));
      case '/api/ask/decide': {
        const id = String(body.id ?? '');
        const r = readHitl(paths(root).hitl).raised.find((x) => x.id === id);
        if (!r) throw new HttpError(404, `no request ${id}`);
        if (r.answered) throw new HttpError(409, `${id} was decided already`);
        const option = r.options[Number(body.option)];
        if (!option) throw new HttpError(400, 'pick one of its options');
        const applied = await applyChanges(root, option.changes, { what: `${option.label}: ${r.question.slice(0, 80)}`, by: OWNER(), source: id });
        appendHitl(paths(root).hitl, { type: 'answered', id, at: new Date().toISOString(), option: Number(body.option) });
        changed(which, 'hitl');
        return reply(res, 200, applied);
      }
      case '/api/rate': {
        // ▲ Keep asking / ▼ Decide these yourself (spec §7.3), on a kind of request Helix named.
        const name = String(body.name ?? '').trim();
        if (name.length < 3) throw new HttpError(400, 'name the kind of request');
        const request = REQUESTS.find((r) => r.kind === body.request)?.kind;
        if (request === 'release' || request === 'human_done') throw new HttpError(409, 'releases and human tasks always wait for you; no rating changes that');
        return reply(res, 200, addRule(roots.real, { name: name.slice(0, 80), request, decide: body.decide === 'helix' ? 'helix' : 'ask', from: typeof body.from === 'string' ? body.from : undefined }));
      }
      case '/api/rule/undo': {
        const rules = readRules(roots.real);
        const next = rules.filter((r) => r.id !== body.id);
        if (next.length === rules.length) throw new HttpError(404, 'no such rule');
        await commitFile(roots.real, writeRules(roots.real, next), `Helix: rule ${body.id} removed (${OWNER()}, in Helix Loop)`);
        changed('real', 'config');
        return reply(res, 200, { rules: next });
      }
      case '/api/resolved': {
        // Agree, Undo or Always ask, on what Helix resolved (spec §7.4); `ids` agrees with several at once.
        const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id ?? '')];
        const { records } = readHitl(paths(root).hitl);
        const rating = body.rating === 'undo' ? 'undo' : body.rating === 'always_ask' ? 'always_ask' : 'agree';
        for (const id of ids) {
          const rec = records.find((r) => r.id === id);
          if (!rec) throw new HttpError(404, `no record ${id}`);
          if (rating === 'undo' && rec.change) await undoChange(root, rec.change);
          if (rating === 'always_ask') addRule(roots.real, { name: rec.name ?? rec.request, request: rec.request, decide: 'ask', from: id });
          appendHitl(paths(root).hitl, { type: 'rated', id, at: new Date().toISOString(), rating });
        }
        changed(which, 'hitl');
        return reply(res, 200, { rated: ids.length });
      }
      case '/api/secret':
        return reply(res, 200, await addSecret(which, body));
      case '/api/home/seen': {
        const s = loadSettings(settingsFile);
        saveSettings(settingsFile, { ...s, lastHome: { at: new Date().toISOString(), finish: view('real').board.finish, mode: pilotOf(loadConfig(roots.real)).mode } });
        return reply(res, 200, { ok: true });
      }
      case '/api/dismiss': {
        const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id)];
        const s = loadSettings(settingsFile);
        saveSettings(settingsFile, { ...s, dismissed: [...new Set([...(s.dismissed ?? []), ...ids])] });
        views.clear();
        changed('real', 'settings');
        changed('dry', 'settings');
        return reply(res, 200, { ok: true });
      }
      case '/api/ui': {
        const s = loadSettings(settingsFile);
        const ui = { ...(s.ui ?? {}) };
        for (const [k, v] of Object.entries(body)) if (k !== 'root' && /^[\w.:-]{1,80}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) ui[k] = v as string;
        saveSettings(settingsFile, { ...s, ui });
        return reply(res, 200, { ok: true });
      }

      // ---- releases ----
      case '/api/release':
        return reply(res, 200, cliJob(which, `Release ${body.repo}`, ['release', 'run', repoArg(loadConfig(root), body.repo)]));
      case '/api/approve':
        if (!pendingApprovals(paths(root).approvals, repoArg(loadConfig(root), body.repo)).some((a) => a.approval.tag === body.tag)) throw new HttpError(409, `${body.repo} ${body.tag} is not waiting for approval`);
        if (body.read !== true) throw new HttpError(400, 'confirm that you read the changes to the reviewed paths');
        return reply(res, 200, cliJob(which, `Approve ${body.repo} ${body.tag}`, ['release', 'approve', repoArg(loadConfig(root), body.repo), String(body.tag)]));
      case '/api/export': {
        const what = String(body.what);
        if (!['map', 'metrics', 'render', 'validate'].includes(what)) throw new HttpError(400, 'export map, metrics, render or validate');
        return reply(res, 200, cliJob(which, { map: 'Export the dependency map', metrics: 'Save a metrics version', render: 'Render the plan documents', validate: 'Validate the plan' }[what]!, { map: ['plan', 'map'], metrics: ['metrics'], render: ['plan', 'render'], validate: ['validate'] }[what]!));
      }

      // ---- conversations ----
      case '/api/comment': {
        const target = String(body.target ?? '');
        assertTarget(which, target);
        const t = body.parent ? addReply(dir, target, String(body.parent), String(body.text ?? '')) : addComment(dir, target, String(body.text ?? ''));
        helix.ask(root, t.key);
        return reply(res, 200, t);
      }
      case '/api/converse': {
        // Ask Helix: a conversation of its own, about anything, or about a selection on Home or a pass in Live.
        const about: string[] = Array.isArray(body.about) ? body.about.map(String).slice(0, 200) : [];
        const text = String(body.text ?? '').trim();
        if (!text) throw new HttpError(400, 'write your question first');
        const t = addComment(dir, newConversationTarget(dir), about.length ? `${text}\n\nAbout: ${about.join(', ')}` : text);
        helix.ask(root, t.key);
        return reply(res, 200, t);
      }
      case '/api/message': {
        const t = addMessage(dir, String(body.key ?? ''), 'owner', String(body.text ?? ''));
        helix.ask(root, t.key);
        return reply(res, 200, t);
      }
      case '/api/resolve': {
        const t = addMessage(dir, String(body.key ?? ''), 'owner', RESOLVE_REQUEST);
        helix.ask(root, t.key);
        return reply(res, 200, t);
      }
      case '/api/proposal': {
        const key = String(body.key ?? '');
        const t = thread(dir, key);
        const p = t?.messages.find((m) => m.kind === 'proposal' && m.id === body.proposal);
        if (!t || !p) throw new HttpError(404, 'no such proposal');
        if (body.decision === 'accepted') {
          const r = await createTask(root, p.task ?? {}, `Plan: {id}: ${p.task?.title ?? 'new task'} (Helix proposal ${p.id}, thread ${key}, accepted by ${OWNER()})`);
          decide(dir, key, p.id, 'accepted', `Created ${r.value.id}.`);
        } else decide(dir, key, p.id, 'declined', typeof body.why === 'string' ? body.why : '');
        helix.ask(root, key);
        return reply(res, 200, thread(dir, key));
      }

      // ---- settings ----
      case '/api/config/apply': {
        const changes = changeSet(body.changes);
        // Try in dry run: a fresh dry run of the plan as it stands, with these values.
        if (body.dry) return reply(res, 200, await startLoop('dry', { agents: AGENTS, configChanges: changes }));
        const r = await applyChangeSet(roots.real, changes);
        changed('real', 'config');
        return reply(res, 200, r);
      }
      case '/api/config/check': {
        checkConfig(roots.real, applyToText(readFileSync(configFile(roots.real), 'utf8'), changeSet(body.changes)));
        return reply(res, 200, { ok: true });
      }
      case '/api/pilot': {
        // Pilot mode applies at once: one commit of config.yaml's pilot section.
        const changes: ChangeSet[] = [];
        if (body.mode === 'active' || body.mode === 'auto') changes.push({ key: 'pilot.mode', value: body.mode });
        if (['cautious', 'prudent', 'intrepid'].includes(body.active_level)) changes.push({ key: 'pilot.active_level', value: body.active_level });
        if (['intrepid', 'yolo'].includes(body.auto_level)) changes.push({ key: 'pilot.auto_level', value: body.auto_level });
        if (typeof body.record === 'boolean') changes.push({ key: 'pilot.record', value: body.record });
        const r = await applyChangeSet(roots.real, changes);
        changed('real', 'config');
        return reply(res, 200, r);
      }
      case '/api/feedback': {
        // One kind's rule, for every lane or for one lane.
        const kind = String(body.kind) as FeedbackKind;
        if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'not a feedback kind');
        const lane = body.lane ? repoArg(loadConfig(root), body.lane) : undefined;
        const base = lane ? `feedback.lanes.${lane}.${kind}` : `feedback.${kind}`;
        const changes: ChangeSet[] = [];
        if (['inbox', 'helix', 'off'].includes(body.send_to)) changes.push({ key: `${base}.send_to`, value: body.send_to });
        if (typeof body.after === 'string' && /^(first|task:\d{1,2}|tasks:\d{1,3})$/.test(body.after)) changes.push({ key: `${base}.after`, value: body.after });
        if (typeof body.pause === 'boolean') changes.push({ key: `${base}.pause`, value: body.pause });
        if (typeof body.notify === 'boolean') changes.push({ key: `${base}.notify`, value: body.notify });
        const r = await applyChangeSet(roots.real, changes);
        changed('real', 'config');
        return reply(res, 200, r);
      }
      case '/api/helix/settings': {
        const s = loadSettings(settingsFile);
        const next = { ...(s.helix ?? {}) };
        for (const role of ['assistant', 'monitor'] as const) {
          if (body[role] === undefined) continue;
          const agent = agentArg(body[role]);
          const h = (await health(loadConfig(roots.real))).find((x) => x.agent === agent)!;
          if (!h.helix) throw new HttpError(409, `${agent} can't run Helix yet: it needs to be installed, signed in or given a key, and working`);
          next[role] = agent;
        }
        saveSettings(settingsFile, { ...s, helix: next });
        const changes: ChangeSet[] = [];
        if (typeof body.monitorEnabled === 'boolean') changes.push({ key: 'helix.monitor.enabled', value: body.monitorEnabled });
        if ((MONITOR_LEVELS as readonly string[]).includes(body.monitorLevel)) changes.push({ key: 'helix.monitor.level', value: body.monitorLevel });
        // null: back to the level's own cap.
        if (body.monitorBudget === null || (typeof body.monitorBudget === 'number' && body.monitorBudget >= 0 && body.monitorBudget <= 500)) changes.push({ key: 'helix.monitor.daily_budget_usd', value: body.monitorBudget });
        if (changes.length) await applyChangeSet(roots.real, changes);
        changed('real', 'config');
        changed('real', 'settings');
        return reply(res, 200, { helix: next });
      }
      case '/api/helix/watch': {
        if (!monitorOn()) throw new HttpError(409, "Helix's monitor is off: turn it on in Settings › Helix");
        monitorAt = Date.now();
        helix.watch(roots.real);
        return reply(res, 200, { queued: true });
      }
      case '/api/prompt':
        if (body.reset) return reply(res, 200, await resetPrompt(roots.real, String(body.name)));
        return reply(res, 200, await savePrompt(roots.real, String(body.name), String(body.text ?? '')));
      case '/api/setup': {
        const agent = agentArg(body.agent);
        const config = loadConfig(roots.real);
        const done = () => forget(agent);
        if (body.action === 'install') {
          const [cmd, ...args] = INSTALL[agent];
          return reply(res, 200, jobs.start(`Install ${agent}`, cmd!, args, { cwd: opts.root, onExit: done }));
        }
        if (body.action === 'signin') return reply(res, 200, jobs.start(`Sign ${agent} in with its subscription`, config.agents[agent].command, SIGN_IN[agent], { cwd: opts.root, onExit: done }));
        throw new HttpError(400, 'action is install or signin');
      }
      case '/api/key': {
        const agent = agentArg(body.agent);
        if (body.key === null) await deleteKey(agent);
        else await saveKey(agent, String(body.key ?? ''));
        forget(agent);
        return reply(res, 200, { ok: true });
      }
      case '/api/taskset/init':
        if (readTaskSetFile(roots.real)) throw new HttpError(409, 'plan/taskset.yaml exists already');
        return reply(res, 200, cliJob('real', 'Write the TaskSet: one epic per repo, feature and stage', ['taskset', 'init']));
      case '/api/taskset/import': {
        const from = String(body.path ?? '').replace(/^~(?=\/)/, process.env.HOME ?? '~');
        if (!/^\/[\w ./@-]+$/.test(from) || from.includes('..')) throw new HttpError(400, 'an absolute path to a TaskSet folder or zip');
        return reply(res, 200, cliJob('real', `Check a TaskSet against the running plan`, ['taskset', 'import', from, ...(body.apply ? ['--apply'] : []), ...(body.dry ? ['--dry-run'] : [])]));
      }
      case '/api/skill/pack':
        return reply(res, 200, await packSkill(PACKAGE_ROOT, join(paths(roots.real).runs, 'helix-skill.zip')));
      case '/api/skill/install': {
        const to = String(body.dir ?? '').replace(/^~(?=\/)/, process.env.HOME ?? '~');
        if (!/^\/[\w ./-]+$/.test(to) || to.includes('..')) throw new HttpError(400, 'an absolute folder, like ~/.claude/skills/helix');
        return reply(res, 200, installSkill(PACKAGE_ROOT, to));
      }
      default:
        throw new HttpError(404, 'not found');
    }
  }

  // ---- what the handlers use ----

  // Notes left for a running task land once its pass has ended and the loop has let go of it.
  let flushing = false;
  async function flushNotes(w: Which) {
    const file = pendingNotes(roots[w]);
    if (flushing || !existsSync(file)) return;
    flushing = true;
    try {
      const all = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { task: string; note: string });
      const plan = snapshot(roots[w]).plan;
      const busy = runningTasks(roots[w], plan);
      const ready = all.filter((n) => !busy.has(n.task));
      if (!ready.length) return;
      const left = all.filter((n) => busy.has(n.task));
      writeFileSync(file, left.map((n) => `${JSON.stringify(n)}\n`).join(''));
      for (const n of ready) {
        const t = loadPlanFresh(roots[w]).tasks.get(n.task);
        if (t) await updateTask(roots[w], n.task, { notes: withNote(t, n.note) }, { fields: ['notes'], message: `Plan: ${n.task} note for its next attempt (${OWNER()}, in Helix Loop)` }).catch((e) => console.error(`note for ${n.task}: ${(e as Error).message}`));
      }
    } catch (e) {
      console.error(`pending notes: ${(e as Error).message}`);
    } finally {
      flushing = false;
    }
  }

  function stateOf(which: Which) {
    const root = roots[which];
    const config = configOf(which);
    const s = loadSettings(settingsFile);
    const base = appState(root, snap(which), config, { dryRun: which === 'dry', dismissed: new Set(s.dismissed) });
    const v = view(which);
    const reads = readReads(root);
    const pilot = pilotOf(loadConfig(roots.real));
    const hitl = readHitl(paths(root).hitl);
    const recent = hitl.records.filter((r) => !s.lastHome?.at || r.at >= s.lastHome.at);
    const monitor = monitorOf(loadConfig(roots.real));
    const { inbox: _inbox, threads: _threads, ...rest } = base;
    return {
      ...rest,
      name: projectInfo(loadConfig(roots.real)).name,
      project: projectInfo(loadConfig(roots.real)),
      lanes: Object.keys(loadConfig(roots.real).repos),
      paused: existsSync(paths(root).pause),
      dryRunExists: existsSync(configPath(roots.dry)),
      finish: v.board.finish,
      codeFinish: v.board.codeFinish,
      timelines: v.board.timelines,
      live: base.live.map((x) => ({ ...x, helix: reads.get(x.task)?.text })),
      counts: {
        home: v.groups.filter((g) => g.kind !== 'notices' && g.kind !== 'resolved').reduce((n, g) => n + g.members.length, 0),
        live: base.live.length,
        helix: v.incidents.filter((i) => i.fix && !i.decision && i.open).length + hitl.raised.filter((r) => !r.answered).length,
      },
      pilot,
      merges: mergeBuckets(snap(which).events, Date.now()),
      resolved: { total: recent.length, unsure: recent.filter((r) => r.confidence < 0.7 && !hitl.ratings.has(r.id)).length, compared: pilot.active_level },
      helix: { status: helix.status(), assistant: helixAgent('assistant'), monitor: { enabled: monitor.enabled, level: monitor.level, agent: helixAgent('monitor'), budgetUsd: monitor.budgetUsd, budgetSet: monitor.budgetSet, spentUsd: monitorSpentToday(paths(roots.real).helixTurns, localDay(Date.now()), localDay) } },
      ui: s.ui ?? {},
      jobs: jobs.list(),
    };
  }

  async function taskDetail(which: Which, id: string) {
    const root = roots[which];
    const plan = snap(which).plan;
    const task = plan.tasks.get(id);
    const human = plan.human.get(id);
    if (!task && !human) throw new HttpError(404, `no task ${id}`);
    const dir = paths(root).threads;
    const targets = [id, ...(task?.blocked_by ?? human?.blocked_by ?? []).map((d) => `${id}~${d}`)];
    const v = view(which);
    const live = stateOf(which).live.find((p) => p.task === id);
    const events = snap(which).events;
    const passes = events.filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.task === id);
    return {
      task,
      human: human && { ...human, steps: stepsOf(human), done: doneSteps(human) },
      board: v.board.tasks.find((t) => t.id === id) ?? v.board.human.find((h) => h.id === id),
      epic: task ? v.board.epics.find((e) => e.tasks.includes(id)) : undefined,
      running: runningTasks(root, plan).has(id),
      live,
      reports: readReports(root).filter((r) => r.task === id).slice(-30),
      history: task ? builderHistory(plan, events, id, live) : [],
      commits: task?.status === 'done' ? await taskCommits(root, events, id) : undefined,
      merged: events.findLast((e): e is Extract<LedgerEvent, { kind: 'merge' }> => e.kind === 'merge' && e.task === id),
      cost: { usd: passes.reduce((n, e) => n + e.costUsd, 0), ms: passes.reduce((n, e) => n + e.durationMs, 0), passes: passes.length },
      remote: task ? await remoteUrl(root, task.repo) : undefined,
      unblocks: [...plan.tasks.values()].filter((t) => t.blocked_by.includes(id)).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      threads: Object.fromEntries(targets.map((t) => [t, threadsOf(t, readEntries(dir, t))])),
    };
  }

  // Everything a group's screen shows (spec §6.3).
  async function groupDetail(which: Which, id: string) {
    const root = roots[which];
    const v = view(which);
    const g = v.groups.find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'that group is gone: everything in it was handled');
    const plan = snap(which).plan;
    const inc = g.incident ? v.incidents.find((i) => i.key === g.incident) : undefined;
    const out: Record<string, unknown> = { group: g };
    if (g.kind === 'your_tasks') {
      const human = g.members.map((m) => {
        const h = plan.human.get(m.id)!;
        const b = v.board.human.find((x) => x.id === m.id)!;
        const waiting = [...[...plan.tasks.values()].filter((t) => t.blocked_by.includes(h.id) && t.status !== 'done'), ...[...plan.human.values()].filter((x) => x.blocked_by.includes(h.id) && x.status !== 'done')];
        return { ...h, held: b.held, late: b.late, latestStart: b.latestStart, critical: b.critical, steps: stepsOf(h), done: doneSteps(h), unblocks: waiting.map((t) => ({ id: t.id, title: t.title, status: t.status })) };
      });
      out.human = human;
      // Worked out, not written: what doing the two that hold the most today does to the finish.
      const top = human.slice(0, 2).map((h) => h.id);
      const cost = { ...v.input, rank: v.board.rank, slots: v.board.slots, finish: v.board.finish };
      const gain = top.length ? finishMoved(cost, top, { doneNow: true }) : 0;
      out.advice = { ids: top, gainMs: gain, finish: v.board.finish - gain, perTask: Object.fromEntries(human.slice(0, 8).map((h) => [h.id, finishMoved(cost, [h.id], { waitMs: 86_400_000 })])) };
    }
    if (inc) {
      const reports = readReports(root).filter((r) => r.kind === 'issue' && inc.members.some((m) => m.task === r.task));
      out.incident = inc;
      out.quotes = reports.slice(-40).reverse().map((r) => ({ task: r.task, title: plan.tasks.get(r.task)?.title, agent: r.agent, at: r.at, message: r.message }));
      // The failures over time, and the latest gate output, for Accept fix's evidence.
      const latest = [...inc.members].filter((m) => m.log).sort((a, b) => b.last.localeCompare(a.last))[0];
      if (latest?.log) out.lastOutput = { task: latest.task, attempt: latest.attempt, text: gateTail(root, latest.log) };
      out.timeline = hourly(inc.times, Date.now());
    }
    if (g.kind === 'release') {
      out.releases = await Promise.all(g.members.map(async (m) => {
        const [repo, tag] = m.id.split('@');
        return { repo, tag, ...(await releaseFiles(root, repo!, tag!)) };
      }));
    }
    if (g.kind === 'scope') {
      out.tasks = g.members.map((m) => {
        const t = plan.tasks.get(m.id)!;
        return { id: t.id, title: t.title, status: t.status, estimate: t.estimate_passes, attempts: t.attempts.map((a) => ({ agent: a.agent, outcome: a.outcome, at: a.at, note: a.note?.split('\n')[0] })), acceptance: t.acceptance, notes: t.notes };
      });
    }
    if (g.kind === 'ask') out.raised = readHitl(paths(root).hitl).raised.filter((r) => g.members.some((m) => m.id === r.id));
    if (g.kind === 'credential') {
      const name = g.incident?.startsWith('cred:') ? g.incident.slice(5) : undefined;
      out.secret = { name, repos: [...new Set(g.members.map((m) => plan.tasks.get(m.id)?.repo).filter(Boolean))], prepare: Object.fromEntries(Object.entries(configOf(which).repos).map(([r, c]) => [r, c.prepare ?? ''])) };
    }
    if (g.kind === 'resolved') out.resolved = resolvedRecord(v, loadSettings(settingsFile).lastHome?.at);
    if (g.kind === 'stopped') {
      out.tasks = g.members.map((m) => {
        const t = plan.tasks.get(m.id);
        return { id: m.id, title: m.title, status: t?.status, attempts: (t?.attempts ?? []).slice(-4).map((a) => ({ agent: a.agent, outcome: a.outcome, at: a.at, note: a.note?.split('\n').slice(0, 3).join('\n'), log: a.log })) };
      });
    }
    return out;
  }

  // An agent's passes that ended today (local time), newest first: the rest of what Live shows is in the state.
  function agentDetail(which: Which, name: string) {
    if (!(AGENTS as readonly string[]).includes(name)) throw new HttpError(400, `not an agent: ${name}`);
    const { plan, events } = snap(which);
    const day = localDay(Date.now());
    const today = events.filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.agent === name && localDay(Date.parse(e.at)) === day);
    return {
      today: today.reverse().slice(0, 60).map((e) => ({
        at: e.at, task: e.task, title: plan.tasks.get(e.task)?.title, attempt: e.attempt, outcome: e.outcome,
        durationMs: e.durationMs, costUsd: e.costUsd, log: e.log, failing: e.failing, toolCalls: e.toolCalls, model: e.model,
      })),
    };
  }

  function settingsOf(which: Which) {
    const config = loadConfig(roots.real);
    const state = stateOf(which);
    const pv = pilotView(roots.real, config);
    const v = view('real');
    return {
      pilot: { ...pv, table: tableOf(pv.pilot), prompt: listPrompts(roots.real).find((p) => p.name === monitorPromptName(pv.pilot)) },
      controls: {
        groups: GROUPS,
        controls: CONTROLS.map((c) => ({ ...c, value: getValue(config, c) })),
        effects: effects({ config, events: snap('real').events, agents: state.agents, now: Date.now() }),
        models: { claude: [...new Set(Object.values(config.agents.claude.models).map((m) => m.model))], codex: [...new Set(Object.values(config.agents.codex.models).map((m) => m.model))] },
      },
      feedback: {
        kinds: FEEDBACK_KINDS.map((k) => ({ kind: k, ...FEEDBACK_LABELS[k], rule: feedbackRule(config, k), preset: DEFAULT_FEEDBACK[k] })),
        lanes: Object.entries(config.feedback?.lanes ?? {}).map(([lane, rules]) => ({ lane, rules })),
        repos: Object.keys(config.repos),
        counts: Object.fromEntries(FEEDBACK_KINDS.map((k) => [k, v.incidents.filter((i) => i.kind === k).reduce((n, i) => n + i.failures, 0)])),
      },
      prompts: listPrompts(roots.real),
      // What each monitor level would have spent over the last day of the real loop, on the monitor's agent.
      monitorLevels: estimateLevels({ config, agent: helixAgent('monitor'), events: snap('real').events, reports: readReports(roots.real), costs: monitorTurnCosts(paths(roots.real).helixTurns), now: Date.now() }),
      releases: state.releases,
      reviewPaths: config.release.review_paths,
      releaseEvery: config.release.every_merged_tasks,
      taskset: tasksetSummary(),
      skill: skillInfo(PACKAGE_ROOT),
    };
  }

  function tasksetSummary() {
    const v = view('real');
    const plan = snap('real').plan;
    const file = readTaskSetFile(roots.real);
    const problems = snap('real').problems;
    const tooBig = [...plan.tasks.values()].filter((t) => t.status !== 'done' && t.estimate_passes > 1).length;
    const noTest = [...plan.tasks.values()].filter((t) => !t.acceptance?.length).length;
    return {
      file: !!file,
      lanes: v.board.lanes.length,
      epics: v.board.epics.length,
      tasks: plan.tasks.size,
      human: plan.human.size,
      deps: [...plan.tasks.values()].reduce((n, t) => n + t.blocked_by.length, 0),
      critical: v.board.criticalPath.length,
      problems: problems.length,
      checks: [
        file
          ? { ok: !v.board.missingEpics.length, text: v.board.missingEpics.length ? `${v.board.missingEpics.length} tasks name no declared epic` : 'Every task sits in a lane and an epic' }
          : { ok: false, warn: true, text: 'Epics are derived from feature and stage until plan/taskset.yaml is written' },
        { ok: !problems.some((p) => /cycle/i.test(p.message)), text: `No dependency cycles; ${v.board.criticalPath.length} tasks on the critical path` },
        { ok: !problems.some((p) => /requirement/i.test(p.message)), text: 'Every requirement maps to at least one task' },
        { ok: tooBig === 0, warn: tooBig > 0, text: tooBig ? `${tooBig} open tasks are estimated at more than one pass` : 'Every task fits one pass' },
        { ok: noTest === 0, warn: noTest > 0, text: noTest ? `${noTest} tasks name no acceptance test` : 'Every task names an acceptance test' },
      ],
      merged: v.board.tasks.filter((t) => t.status === 'done').length,
      finish: v.board.finish,
      codeFinish: v.board.codeFinish,
      running: loopStatus(roots.real, snap('real').events).running,
      plans: { spec: existsSync(paths(roots.real).spec), clarifications: existsSync(paths(roots.real).clarifications) },
    };
  }

  async function humanAction(which: Which, body: Record<string, any>) {
    const root = roots[which];
    const id = String(body.id ?? '');
    const h = loadPlan(paths(root).tasks, paths(root).human).human.get(id);
    if (!h) throw new HttpError(404, `no human task ${id}`);
    const patch: Partial<HumanTask> = {};
    if (body.status !== undefined) {
      if (!['todo', 'in_progress', 'done'].includes(body.status)) throw new HttpError(400, 'status is todo, in_progress or done');
      patch.status = body.status;
    }
    let notes = h.notes ?? '';
    // The checklist's ticks, kept as one line of the notes.
    if (Array.isArray(body.steps)) {
      const done = body.steps.map(Number).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
      notes = [done.length ? `Steps done: ${done.join(', ')}` : '', notes.replace(/^Steps done:.*$\n?/m, '').trim()].filter(Boolean).join('\n');
    }
    if (typeof body.snooze === 'string') {
      notes = [body.snooze ? `Snoozed until ${body.snooze.slice(0, 10)}` : '', notes.replace(/^Snoozed until .*$\n?/m, '').trim()].filter(Boolean).join('\n');
    }
    if (typeof body.evidence === 'string' && body.evidence.trim()) notes = [notes, `Evidence (${new Date().toISOString().slice(0, 10)}): ${body.evidence.trim().slice(0, 1000)}`].filter(Boolean).join('\n');
    if (notes !== (h.notes ?? '')) patch.notes = notes;
    if (!Object.keys(patch).length) return { value: h, committed: false };
    const what = patch.status ? patch.status.replace('_', ' ') : body.snooze !== undefined ? (body.snooze ? `snoozed until ${body.snooze.slice(0, 10)}` : 'unsnoozed') : 'checklist updated';
    const r = await updateHuman(root, id, patch, { fields: ['status', 'notes'], message: `Plan: ${id} ${what} (${OWNER()}, in Helix Loop)` });
    // Done: Helix's monitor adds what builders need from it (an ID, never a secret) to the tasks waiting on it.
    if (patch.status === 'done' && monitorOn()) helix.watch(root, `human:${id}`);
    return r;
  }

  // Answer once (spec §6.3): into the notes of every task asked, and optionally the spec and a rule.
  async function answerOnce(which: Which, body: Record<string, any>) {
    const root = roots[which];
    const key = String(body.key ?? '');
    const text = String(body.text ?? '').trim();
    if (text.length < 8) throw new HttpError(400, 'write the answer first');
    const inc = view(which).incidents.find((i) => i.key === key);
    if (!inc) throw new HttpError(404, 'no such question');
    const tasks: string[] = Array.isArray(body.tasks) && body.tasks.length ? body.tasks.map(String) : inc.members.map((m) => m.task);
    const about = key.startsWith('spec:') ? key.slice(5) : inc.cause.slice(0, 40);
    const out: Record<string, unknown> = {};
    if (body.notes !== false) {
      const plan = loadPlan(paths(root).tasks, paths(root).human);
      const open = tasks.filter((id) => ['ready', 'needs_human', 'parked'].includes(plan.tasks.get(id)?.status ?? ''));
      const changes: PlanChange[] = open.map((task) => ({ op: plan.tasks.get(task)!.status === 'ready' ? 'note' : 'hand_back', task, note: `Answer about ${about}: ${text}` }) as PlanChange);
      out.applied = await applyChanges(root, changes, { what: `answer ${changes.length} question${changes.length === 1 ? '' : 's'} about ${about}`, by: OWNER(), source: `incident ${key}` });
    }
    if (body.spec) out.clarification = await addClarification(roots.real, about, text, tasks);
    if (body.rule) out.rule = addRule(roots.real, { name: `spec questions about ${about}`, request: 'spec_plain', decide: 'helix' });
    if (inc.fix) appendStored(paths(root).incidents, { type: 'decided', key, at: new Date().toISOString(), fix: inc.fix.id, decision: 'accepted' });
    changed(which, 'incidents');
    return out;
  }

  // Add the secret (spec §6.3): the value goes from this request straight to the keychain or GitHub, on standard
  // input, and is never logged, stored or shown again. The tasks it stopped then go back to the loop.
  async function addSecret(which: Which, body: Record<string, any>) {
    const root = roots[which];
    const name = String(body.name ?? '');
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) throw new HttpError(400, 'a secret name is upper case, like STRIPE_TEST_KEY');
    const value = String(body.value ?? '');
    if (!value || /\n/.test(value) || value.length > 10_000) throw new HttpError(400, 'paste the value on one line');
    if (body.where === 'github') {
      const repo = repoArg(loadConfig(root), body.repo);
      const remote = await git(join(paths(root).repos, repo), 'remote', 'get-url', 'origin').catch(() => '');
      const slug = /github\.com[:/](.+?)(\.git)?$/.exec(remote)?.[1];
      if (!slug) throw new HttpError(409, `${repo} has no GitHub remote`);
      const env = String(body.env ?? '').trim();
      if (env && !/^[\w-]+$/.test(env)) throw new HttpError(400, 'an environment name, like production');
      const r = await run('gh', ['secret', 'set', name, '--repo', slug, ...(env ? ['--env', env] : [])], { cwd: tmpdir(), stdin: value, timeoutMs: 60_000 });
      if (r.code !== 0) throw new HttpError(409, `gh refused it: ${r.stderr.split(value).join('***').trim().slice(0, 300)}`);
    } else {
      const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
      const r = await run('security', ['-i'], { cwd: tmpdir(), stdin: `add-generic-password -U -s ${quote(`Helix Loop: ${name}`)} -a ${quote(name)} -w ${quote(value)}\n`, timeoutMs: 20_000 });
      if (r.code !== 0 || /error/i.test(r.stderr)) throw new HttpError(409, `the keychain refused it: ${r.stderr.split(value).join('***').trim().slice(0, 200)}`);
    }
    const tasks: string[] = Array.isArray(body.tasks) ? body.tasks.map(String) : [];
    const waiting = tasks.filter((id) => ['needs_human', 'parked'].includes(snap(which).plan.tasks.get(id)?.status ?? ''));
    const handed = waiting.length ? await applyChanges(root, waiting.map((task) => ({ op: 'hand_back', task, note: `${name} is set now.` }) as PlanChange), { what: `hand back ${waiting.length} task${waiting.length === 1 ? '' : 's'}: ${name} is set`, by: OWNER() }) : undefined;
    return { saved: name, where: body.where === 'github' ? 'github' : 'keychain', handed };
  }

  function addRule(root: string, r: Omit<Rule, 'id' | 'at'>): Rule {
    const rules = readRules(root);
    const rule: Rule = { id: `R-${Math.max(0, ...rules.map((x) => Number(x.id.slice(2)) || 0)) + 1}`, at: new Date().toISOString(), ...r };
    const file = writeRules(root, [...rules.filter((x) => x.name.toLowerCase() !== r.name.toLowerCase()), rule]);
    void commitFile(root, file, `Helix: rule ${rule.id}, ${rule.decide === 'helix' ? 'decide' : 'always ask about'} "${rule.name}" (${OWNER()}, in Helix Loop)`);
    changed('real', 'config');
    return rule;
  }

  async function commitFile(root: string, file: string, message: string) {
    if (!existsSync(join(root, '.git'))) return false;
    return commit(root, [relative(root, file)], message).catch(() => false);
  }

  // A builder's report_issue under a Pause or Notify rule (spec §10): its pass stops at once and the task waits
  // for the owner, or a notification goes out.
  function onFeedback(task: string) {
    const r = readReports(roots.real).findLast((x) => x.task === task && x.kind === 'issue');
    if (!r || Date.now() - Date.parse(r.at) > 5000) return;
    const kind = (({ plan_problem: 'scope_grew', flake: 'flaky_test' }) as Record<string, string>)[r.issue ?? ''] ?? r.issue;
    if (!(FEEDBACK_KINDS as readonly string[]).includes(kind ?? '')) return;
    const rule = feedbackRule(loadConfig(roots.real), kind as FeedbackKind, snap('real').plan.tasks.get(task)?.repo);
    if (rule.pause) writeStopRequest(roots.real, task, { to: 'needs_human', why: `${kind!.replace('_', ' ')}: ${r.message.slice(0, 200)}` });
    if (rule.notify && process.platform === 'darwin') {
      const msg = `${task}: ${r.message.slice(0, 140)}`.replace(/["\\]/g, '');
      spawn('osascript', ['-e', `display notification "${msg}" with title "Helix Loop: ${FEEDBACK_LABELS[kind as FeedbackKind].label}"`], { stdio: 'ignore', detached: true }).unref();
    }
  }

  function assertTarget(which: Which, target: string): void {
    if (!isTarget(target)) throw new HttpError(400, `not a task, human task or dependency: ${target}`);
    if (target.startsWith('S-')) return;
    const plan = snap(which).plan;
    const [a, b] = target.split('~');
    const has = (x: string) => plan.tasks.has(x) || plan.human.has(x);
    if (!has(a!) || (b && !(plan.tasks.get(a!)?.blocked_by ?? plan.human.get(a!)?.blocked_by ?? []).includes(b))) throw new HttpError(404, `${target} is not in the plan`);
  }

  // One of the CLI's own commands, against this root, watched as a job.
  function cliJob(which: Which, title: string, args: string[]): Job {
    return jobs.start(title, process.execPath, [BIN, ...args, '--root', roots[which]], {
      cwd: opts.root,
      label: `helix-loop ${args.join(' ')}${which === 'dry' ? ' (dry run)' : ''}`,
      onExit: () => changed(which, 'ledger'),
    });
  }

  async function startLoop(which: Which, body: Record<string, any>) {
    const root = roots[which];
    if (which === 'real' && loopStatus(root, snap('real').events).running) throw new HttpError(409, 'the loop is already running');
    if (which === 'dry' && loopStatus(roots.dry, existsSync(paths(roots.dry).ledger) ? snapshot(roots.dry).events : []).running) throw new HttpError(409, 'a dry run is already running');
    const agents: AgentName[] = Array.isArray(body.agents) ? body.agents.filter((a: string) => (AGENTS as readonly string[]).includes(a)) : [];
    if (!agents.length) throw new HttpError(400, 'pick at least one agent');
    if (which === 'real') {
      // Builders only on a subscription, installed and working: the same check the loop makes before each pass.
      const h = await health(loadConfig(root));
      const bad = agents.filter((a) => !h.find((x) => x.agent === a)?.builder);
      if (bad.length) throw new HttpError(409, `${bad.join(' and ')} can't build: see Settings › Agents`);
    }
    const max = Number(body.maxPasses);
    let changesFile: string | undefined;
    if (which === 'dry' && Array.isArray(body.configChanges) && body.configChanges.length) {
      // Checked now against the real config, so a bad value fails here rather than in the dry run's log.
      checkConfig(roots.real, applyToText(readFileSync(configFile(roots.real), 'utf8'), body.configChanges));
      changesFile = join(paths(opts.root).runs, 'dry-run-config.json');
      writeFileSync(changesFile, JSON.stringify(body.configChanges));
    }
    let planFile: string | undefined;
    if (which === 'dry' && Array.isArray(body.planChanges) && body.planChanges.length) {
      planFile = join(paths(opts.root).runs, 'dry-run-plan.json');
      writeFileSync(planFile, JSON.stringify(body.planChanges));
    }
    const args = [BIN, 'run', '--root', opts.root, '--agents', agents.join(','), ...(max > 0 ? ['--max-passes', String(Math.floor(max))] : []), ...(which === 'dry' ? ['--dry-run'] : []), ...(changesFile ? ['--config-changes', changesFile] : []), ...(planFile ? ['--plan-changes', planFile] : [])];
    // The log sits outside the dry run's root, which each dry run replaces.
    const logFile = join(paths(opts.root).runs, which === 'dry' ? 'dry-run.log' : 'loop.log');
    const fd = openSync(logFile, 'a');
    const child = spawn(process.execPath, args, { cwd: opts.root, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    closeSync(fd);
    changed(which, 'loop');
    return { pid: child.pid, log: relative(opts.root, logFile) };
  }

  function logPath(rel: string): string {
    const clean = normalize(rel);
    if (!/^runs\/logs\/[\w./-]+\.log(\.gz)?$/.test(clean) || clean.includes('..')) throw new HttpError(400, 'not a pass log');
    return clean;
  }

  function readLog(root: string, rel: string): string {
    const clean = logPath(rel);
    const file = [logFile(root, clean), logFile(root, `${clean}.gz`)].find((f) => existsSync(f));
    if (!file) throw new HttpError(404, 'that log is gone');
    const buf = readFileSync(file);
    const s = (file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
    return s.length > 2_000_000 ? `… (the first ${s.length - 2_000_000} characters are left out)\n${s.slice(-2_000_000)}` : s;
  }

  // The end of a pass log's gate output: from its last gate run, without the builder's event lines.
  function gateTail(root: string, rel: string): string {
    let s: string;
    try {
      s = readLog(root, rel);
    } catch {
      return '';
    }
    const at = s.lastIndexOf('> gate ');
    return (at >= 0 ? s.slice(at) : s).split('\n').filter((l) => !l.startsWith('{')).slice(-40).join('\n').slice(-4000);
  }

  async function commitDiff(root: string, repo: string, sha: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, 'not a commit');
    return (await exec('git', ['show', '--stat', '--patch', '--format=fuller', sha], { cwd: join(paths(root).repos, repoArg(loadConfig(root), repo)), maxBuffer: 20_000_000 })).stdout.slice(0, 1_500_000);
  }

  async function releaseFiles(root: string, repo: string, tag: string) {
    const a = pendingApprovals(paths(root).approvals, repoArg(loadConfig(root), repo)).find((x) => x.approval.tag === tag)?.approval;
    if (!a) throw new HttpError(404, `${repo} ${tag} is not waiting for approval`);
    const dir = join(paths(root).repos, repo);
    const stat = (await exec('git', ['diff', '--numstat', a.since, a.commit], { cwd: dir, maxBuffer: 20_000_000 })).stdout.trim();
    const reviewed = new Set(a.paths);
    const files = stat.split('\n').filter(Boolean).map((l) => {
      const [add, del, file] = l.split('\t');
      return { file: file!, added: Number(add) || 0, deleted: Number(del) || 0, reviewed: reviewed.has(file!) };
    }).sort((x, y) => Number(y.reviewed) - Number(x.reviewed) || x.file.localeCompare(y.file));
    const held = snap(which(root)).events.filter((e): e is Extract<LedgerEvent, { kind: 'release_held' }> => e.kind === 'release_held' && e.repo === repo && e.tag === tag).at(-1);
    return { since: a.since, commit: a.commit, requestedAt: a.requestedAt, files: files.slice(0, 400), total: files.length, tasks: held?.tasks ?? [], reviewPaths: loadConfig(roots.real).release.review_paths };
  }
  const which = (root: string): Which => (root === roots.dry ? 'dry' : 'real');

  async function releaseFileDiff(root: string, repo: string, tag: string, file: string): Promise<string> {
    const a = pendingApprovals(paths(root).approvals, repoArg(loadConfig(root), repo)).find((x) => x.approval.tag === tag)?.approval;
    if (!a) throw new HttpError(404, `${repo} ${tag} is not waiting for approval`);
    if (!file || file.includes('..')) throw new HttpError(400, 'not a file');
    return (await exec('git', ['diff', a.since, a.commit, '--', file], { cwd: join(paths(root).repos, repo), maxBuffer: 20_000_000 })).stdout.slice(0, 1_000_000);
  }

  async function remoteUrl(root: string, repo: string): Promise<string | undefined> {
    const u = await git(join(paths(root).repos, repo), 'remote', 'get-url', 'origin').catch(() => '');
    const slug = /github\.com[:/](.+?)(\.git)?$/.exec(u)?.[1];
    return slug ? `https://github.com/${slug}` : undefined;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      clearInterval(heartbeat);
      closed = true;
      clearInterval(monitorTick);
      if (monitorTimer) clearTimeout(monitorTimer);
      if (flush) clearTimeout(flush);
      for (const t of Object.values(logsTimers)) clearTimeout(t);
      for (const w of watchers) w.close();
      for (const c of [...clients, ...passClients.keys()]) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const pendingNotes = (root: string) => join(paths(root).runs, 'pending-notes.jsonl');
const loadPlanFresh = (root: string) => snapshot(root).plan;

// A stop request the loop picks up (runs/stop-pass/<task>.json), written whole: a temp name, then a rename.
function writeStopRequest(root: string, task: string, r: { to: 'ready' | 'needs_human'; note?: string; why?: string }): void {
  const dir = paths(root).stopPass;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${task}.tmp`);
  writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...r }));
  renameSync(tmp, join(dir, `${task}.json`));
}

// A human task's steps: the numbered lines under "Steps:" in its handoff prompt.
export function stepsOf(h: HumanTask): string[] {
  const p = h.handoff_prompt ?? '';
  const at = p.search(/^Steps:\s*$/m);
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of p.slice(at).split('\n').slice(1)) {
    const m = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) out.push(m[2]!.trim());
    else if (out.length && line.trim() === '') break;
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}
const doneSteps = (h: HumanTask) => (/^Steps done: (.*)$/m.exec(h.notes ?? '')?.[1] ?? '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0);

// Failures per hour over the incident's span, at most three days back, for its chart.
function hourly(times: number[], now: number): { start: number; counts: number[] } {
  if (!times.length) return { start: now, counts: [] };
  const start = Math.max(Math.min(...times), now - 3 * 86_400_000);
  const n = Math.max(1, Math.ceil((now - start) / 3_600_000));
  const counts = new Array(n).fill(0) as number[];
  for (const t of times) if (t >= start) counts[Math.min(n - 1, Math.floor((t - start) / 3_600_000))]!++;
  return { start, counts };
}

const changeSet = (raw: unknown): ChangeSet[] => {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'nothing to apply');
  return raw.map((c: { key?: unknown; value?: unknown }) => ({ key: String(c.key), value: c.value }));
};
const repoArg = (config: Config, r: unknown) => {
  if (!config.repos[String(r)]) throw new HttpError(400, `not a repo: ${String(r)}`);
  return String(r);
};
const agentArg = (a: unknown): AgentName => {
  if (!(AGENTS as readonly string[]).includes(String(a))) throw new HttpError(400, `not an agent: ${String(a)}`);
  return a as AgentName;
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
}
function text(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(body);
}
function rpcReply(res: ServerResponse, r: { status: number; body?: unknown }): void {
  if (r.body === undefined) return void res.writeHead(r.status).end();
  reply(res, r.status, r.body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'a request is at most 1 MB');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'the body is not JSON');
  }
}
