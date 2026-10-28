import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { ownerOf } from './prompts.ts';
import { asset, BIN, configPath, logFile, FEEDBACK_KINDS, HELIX_DIR, loadConfig, MONITOR_LEVELS, monitorOf, PACKAGE_ROOT, paths, projectInfo, type FeedbackKind } from '../config.ts';
import { git } from '../git.ts';
import { renderDependencyMap } from '../map/render.ts';
import { renderMetrics } from '../metrics/render.ts';
import { run } from '../proc.ts';
import { pendingApprovals } from '../release.ts';
import { installSkill, packSkill, skillInfo } from '../skill.ts';
import { AGENTS, type AgentName } from '../types.ts';
import { localDay } from '../agents/quota.ts';
import type { LedgerEvent } from '../ledger.ts';
import { commit, createTask, PlanEditError } from './actions.ts';
import { finishMoved } from './board.ts';
import { CONTROLS, ConfigEditError, effects, GROUPS, getValue } from './config.ts';
import { readFeed } from './feed.ts';
import { deleteKey, forget, health, INSTALL, saveKey, SIGN_IN } from './health.ts';
import { ASSISTANT_TOOLS, Helix, HELIX_SERVER, monitorSpentToday, monitorTools, readReads, RESOLVE_REQUEST, type HelixRole } from './helix.ts';
import { DEFAULT_FEEDBACK, FEEDBACK_LABELS, feedbackRule, pilotOf, readHitl, tableOf } from './hitl.ts';
import { Jobs, type Job } from './jobs.ts';
import { BUILDER_SERVER, BUILDER_TOOLS, handleRpc, passFor } from './mcp.ts';
import { estimateLevels, monitorChanges, monitorShouldRun, monitorTurnCosts } from './monitor.ts';
import { listPrompts, monitorPromptName, resetPrompt, savePrompt } from './prompts.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { appState, loopStatus, mapModel, metricsModel, readReports, snapshot, type Snapshot } from './state.ts';
import { addComment, addMessage, addReply, allThreads, decide, isTarget, newConversationTarget, thread, ThreadError } from './threads.ts';
import { buildView, helixSummary, mergeBuckets, pilotView, resolvedRecord, welcome, type View } from './views.ts';
import * as ops from '../ops/index.ts';
import { inApp, OpError } from '../ops/actor.ts';
import { PROJECTION_METHOD } from './projection.ts';

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

// monitor: false keeps Helix's monitor from taking turns, for an app the CLI starts for one question (`helix-loop
// ask`): only the app the owner runs watches the loop.
export async function startApp(opts: { root: string; port: number; open?: boolean; monitor?: boolean }): Promise<App> {
  const roots: Record<Which, string> = { real: opts.root, dry: paths(opts.root).dryRun };
  const settingsFile = paths(opts.root).appSettings;
  // Who the app acts for, in commit messages and records: the project's owner.
  const OWNER = () => ownerOf(roots.real);
  const ACTOR = () => inApp(roots.real);
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
  const helixAgent = (role: HelixRole): AgentName => ops.helixAgentOf(roots.real, role);
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
    if (opts.monitor === false) return false;
    const m = monitorNow();
    if (!m?.enabled) return false;
    return monitorSpentToday(paths(roots.real).helixTurns, localDay(Date.now()), localDay) < m.budgetUsd;
  };
  // What the monitor has seen of the ledger and the reports: only what is new since can start a turn. While it is
  // off nothing is read, and it starts from what is there when it comes on.
  let seen: { events: number; reports: number } | undefined;
  const monitorConsider = () => {
    const m = opts.monitor === false ? undefined : monitorNow();
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
    if (a === 'plan' && (b === 'tasks' || b === 'human' || b === 'taskset.yaml' || b === 'milestones.yaml' || b === 'history')) return [w, 'plan'];
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
  // The files a request's own commits changed, announced as the watcher would have.
  const headOf = (root: string) => git(root, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => undefined);
  const announce = async (w: Which, root: string, before: string | undefined) => {
    const after = await headOf(root);
    if (!before || !after || before === after) return;
    const files = await git(root, '-c', 'core.quotePath=false', 'diff', '--name-only', '--relative', before, after).catch(() => '');
    for (const f of files.split('\n')) {
      if (!f.startsWith(HELIX_DIR + '/')) continue;
      const c = classify(normalize(f.slice(HELIX_DIR.length + 1)));
      if (c && c[1] !== 'logs') changed(w, c[1]);
    }
  };

  // ---- requests ----
  const host = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const sameOrigin = (o: string | undefined) => !o || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const tokenOk = (got: string | undefined, want: string) => !!got && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      const status = e instanceof HttpError || e instanceof OpError ? e.status : e instanceof PlanEditError || e instanceof ThreadError || e instanceof ConfigEditError ? 409 : 500;
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
      // Which project this app serves, so the CLI can find it and act through it (src/cli/client.ts).
      if (path === '/api/project') return reply(res, 200, { root: roots.real, name: projectInfo(loadConfig(roots.real)).name });
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
          const sub = { which, log: ops.logPath(log) };
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
      if (path === '/api/log') return text(res, ops.readLog(root, q.get('path') ?? ''));
      if (path === '/api/feed') {
        const rel = ops.logPath(q.get('path') ?? '');
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
    // What a change does to the plan or the config reaches the page from its own commit, not only from the watcher,
    // whose events can come late or not at all for a write made just as it starts (FSEvents on macOS).
    const before = await headOf(root);
    try {
      switch (path) {
        // ---- the loop ----
        case '/api/loop/start':
          return reply(res, 200, await startLoop(which, body));
        case '/api/loop/stop': {
          ops.stopLoop(root);
          changed(which, 'loop');
          return reply(res, 200, { stopping: true });
        }
        case '/api/loop/pause': {
          ops.setPaused(root, !!body.paused, ACTOR());
          changed(which, 'loop');
          return reply(res, 200, { paused: !!body.paused });
        }
        case '/api/pass/stop': {
          const task = String(body.task ?? '');
          ops.stopPass(root, task, { to: body.to === 'needs_human' ? 'needs_human' : 'ready', note: typeof body.note === 'string' ? body.note : undefined, why: `stopped by ${OWNER()} in Live` });
          return reply(res, 200, { stopping: task });
        }

        // ---- the plan: one task, or a batch ----
        case '/api/task/action': {
          const id = String(body.id ?? '');
          const note = typeof body.note === 'string' ? body.note : undefined;
          if (body.action === 'hand_back' || body.action === 'park') return reply(res, 200, await ops.setStatus(root, [id], body.action, { note, actor: ACTOR() }));
          if (body.action === 'add_dep' || body.action === 'remove_dep') return reply(res, 200, await ops.setDep(root, id, String(body.on ?? ''), body.action === 'add_dep', ACTOR()));
          throw new HttpError(400, 'action is hand_back, park, add_dep or remove_dep');
        }
        case '/api/batch': {
          const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 2000) : [];
          if (!ids.length) throw new HttpError(400, 'select at least one task');
          const op = body.action === 'park' ? 'park' : body.action === 'hand_back' ? 'hand_back' : undefined;
          if (!op) throw new HttpError(400, 'action is hand_back or park');
          return reply(res, 200, await ops.setStatus(root, ids, op, { note: typeof body.note === 'string' ? body.note : undefined, actor: ACTOR(), skipUnknown: true, source: typeof body.group === 'string' ? `group ${body.group.slice(0, 80)}` : undefined }));
        }
        case '/api/undo':
          return reply(res, 200, await ops.undo(root, String(body.id ?? ''), ACTOR()));
        case '/api/note-next': {
          // Note for next attempt (spec §6.5): into the task's notes now, or, while its pass runs and the loop holds
          // the task, as soon as the pass ends.
          return reply(res, 200, await ops.addNote(root, String(body.task ?? ''), typeof body.note === 'string' ? body.note : '', ACTOR()));
        }
        case '/api/notes': {
          // A task's notes (its next builder reads them in its prompt) or a human task's, edited in place.
          return reply(res, 200, await ops.setNotes(root, String(body.id ?? ''), typeof body.notes === 'string' ? body.notes : '', ACTOR()));
        }
        case '/api/human/action':
          return reply(res, 200, await humanAction(which, body));

        // ---- Home's screens ----
        case '/api/fix': {
          const key = String(body.key ?? '');
          const incidents = view(which).incidents;
          const inc = incidents.find((i) => i.key === key);
          if (!inc?.fix) throw new HttpError(404, 'no fix waiting for that incident');
          // Try in dry run: a fresh dry run of the plan as it stands, with this fix applied to it.
          if (body.decision === 'dry') return reply(res, 200, await startLoop('dry', { agents: AGENTS, planChanges: inc.fix.changes }));
          if (body.decision === 'revise') {
            if (!monitorOn()) throw new HttpError(409, "Helix's monitor is off: turn it on in Settings › Helix");
            helix.watch(root, key);
            return reply(res, 200, { revising: key });
          }
          const r = await ops.decideFix(root, key, body.decision === 'declined' ? 'declined' : 'accepted', ACTOR(), incidents);
          changed(which, 'incidents');
          return reply(res, 200, r);
        }
        case '/api/answer': {
          // Answer once (spec §6.3): into the notes of every task asked, and optionally the spec and a rule.
          const tasks: string[] | undefined = Array.isArray(body.tasks) && body.tasks.length ? body.tasks.map(String) : undefined;
          const r = await ops.answerOnce(root, String(body.key ?? ''), String(body.text ?? ''), { tasks, notes: body.notes !== false, spec: !!body.spec, rule: !!body.rule, home: roots.real }, ACTOR(), view(which).incidents);
          if (r.rule) changed('real', 'config');
          changed(which, 'incidents');
          return reply(res, 200, r);
        }
        case '/api/ask/decide': {
          const applied = await ops.decideAsk(root, String(body.id ?? ''), Number(body.option), ACTOR());
          changed(which, 'hitl');
          return reply(res, 200, applied);
        }
        case '/api/rate': {
          const rule = await ops.rate(roots.real, { name: String(body.name ?? ''), request: typeof body.request === 'string' ? body.request : undefined, decide: body.decide === 'helix' ? 'helix' : 'ask', from: typeof body.from === 'string' ? body.from : undefined }, ACTOR());
          changed('real', 'config');
          return reply(res, 200, rule);
        }
        case '/api/rule/undo': {
          const r = await ops.undoRule(roots.real, String(body.id ?? ''), ACTOR());
          changed('real', 'config');
          return reply(res, 200, r);
        }
        case '/api/resolved': {
          // Agree, Undo or Always ask, on what Helix resolved (spec §7.4); `ids` agrees with several at once.
          const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id ?? '')];
          const rating = body.rating === 'undo' ? 'undo' : body.rating === 'always_ask' ? 'always_ask' : 'agree';
          const r = await ops.rateResolved(root, roots.real, ids, rating, ACTOR());
          if (rating === 'always_ask') changed('real', 'config');
          changed(which, 'hitl');
          return reply(res, 200, r);
        }
        case '/api/secret': {
          const tasks: string[] = Array.isArray(body.tasks) ? body.tasks.map(String) : [];
          return reply(res, 200, await ops.addSecret(root, { name: String(body.name ?? ''), value: String(body.value ?? ''), where: body.where === 'github' ? 'github' : 'keychain', repo: body.repo, env: typeof body.env === 'string' ? body.env : undefined, tasks }, ACTOR()));
        }
        case '/api/home/seen': {
          const s = loadSettings(settingsFile);
          saveSettings(settingsFile, { ...s, lastHome: { at: new Date().toISOString(), finish: view('real').board.finish, method: PROJECTION_METHOD, mode: pilotOf(loadConfig(roots.real)).mode } });
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
          return reply(res, 200, cliJob(which, `Release ${body.repo}`, ['release', 'run', ops.repoArg(loadConfig(root), body.repo)]));
        case '/api/approve':
          if (!pendingApprovals(paths(root).approvals, ops.repoArg(loadConfig(root), body.repo)).some((a) => a.approval.tag === body.tag)) throw new HttpError(409, `${body.repo} ${body.tag} is not waiting for approval`);
          if (body.read !== true) throw new HttpError(400, 'confirm that you read the changes to the reviewed paths');
          return reply(res, 200, cliJob(which, `Approve ${body.repo} ${body.tag}`, ['release', 'approve', ops.repoArg(loadConfig(root), body.repo), String(body.tag)]));
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
          const changes = ops.parseChangeSet(body.changes);
          // Try in dry run: a fresh dry run of the plan as it stands, with these values.
          if (body.dry) return reply(res, 200, await startLoop('dry', { agents: AGENTS, configChanges: changes }));
          const r = await ops.applyConfig(roots.real, changes, ACTOR());
          changed('real', 'config');
          return reply(res, 200, r);
        }
        case '/api/config/check': {
          ops.checkConfigChanges(roots.real, ops.parseChangeSet(body.changes));
          return reply(res, 200, { ok: true });
        }
        case '/api/pilot': {
          // Pilot mode applies at once: one commit of config.yaml's pilot section. What isn't a mode or level is left out.
          const pick = <T extends string>(v: unknown, of: readonly T[]) => ((of as readonly unknown[]).includes(v) ? (v as T) : undefined);
          const r = await ops.setPilot(roots.real, { mode: pick(body.mode, ['active', 'auto'] as const), active_level: pick(body.active_level, ops.ACTIVE_LEVELS), auto_level: pick(body.auto_level, ops.AUTO_LEVELS), record: typeof body.record === 'boolean' ? body.record : undefined }, ACTOR());
          changed('real', 'config');
          return reply(res, 200, r);
        }
        case '/api/feedback': {
          const r = await ops.setFeedback(root, String(body.kind), { send_to: body.send_to, after: body.after, pause: typeof body.pause === 'boolean' ? body.pause : undefined, notify: typeof body.notify === 'boolean' ? body.notify : undefined }, body.lane ? String(body.lane) : undefined, ACTOR());
          changed('real', 'config');
          return reply(res, 200, r);
        }
        case '/api/helix/settings': {
          const next = await ops.setHelixAgents(roots.real, { assistant: body.assistant === undefined ? undefined : ops.agentArg(body.assistant), monitor: body.monitor === undefined ? undefined : ops.agentArg(body.monitor) });
          // What isn't a level or a cap is left out; null puts the cap back to the level's own.
          await ops.setMonitor(roots.real, {
            enabled: typeof body.monitorEnabled === 'boolean' ? body.monitorEnabled : undefined,
            level: (MONITOR_LEVELS as readonly string[]).includes(body.monitorLevel) ? body.monitorLevel : undefined,
            budget: body.monitorBudget === null || (typeof body.monitorBudget === 'number' && body.monitorBudget >= 0 && body.monitorBudget <= 500) ? body.monitorBudget : undefined,
          }, ACTOR());
          changed('real', 'config');
          changed('real', 'settings');
          return reply(res, 200, { helix: next });
        }
        case '/api/helix/watch': {
          if (!monitorOn()) throw new HttpError(409, "Helix's monitor is off: turn it on in Settings › Helix");
          monitorAt = Date.now();
          // A focus: what to look at, as a human task just done (`human:HT-3`) from the CLI.
          helix.watch(roots.real, typeof body.focus === 'string' && /^human:HT-\d+$/.test(body.focus) ? body.focus : undefined);
          return reply(res, 200, { queued: true });
        }
        case '/api/prompt':
          if (body.reset) return reply(res, 200, await resetPrompt(roots.real, String(body.name)));
          return reply(res, 200, await savePrompt(roots.real, String(body.name), String(body.text ?? '')));
        case '/api/setup': {
          const agent = ops.agentArg(body.agent);
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
          const agent = ops.agentArg(body.agent);
          if (body.key === null) await deleteKey(agent);
          else await saveKey(agent, String(body.key ?? ''));
          forget(agent);
          return reply(res, 200, { ok: true });
        }
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
    } finally {
      void announce(which, root, before);
    }
  }

  // ---- what the handlers use ----

  // Notes left for a running task land once its pass has ended and the loop has let go of it.
  async function flushNotes(w: Which) {
    const r = await ops.landNotes(roots[w], ACTOR());
    for (const f of r.failed) console.error(`note for ${f.task}: ${f.error}`);
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
    return ops.taskStory(roots[which], id, { snap: snap(which), view: view(which), live: stateOf(which).live });
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
      const human = g.members.map((m) => ops.humanCard(plan, v.board, m.id));
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
      if (latest?.log) out.lastOutput = { task: latest.task, attempt: latest.attempt, text: ops.gateTail(root, latest.log) };
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
    const ts = plan.taskset;
    const problems = snap('real').problems;
    const tooBig = [...plan.tasks.values()].filter((t) => t.status !== 'done' && t.estimate_passes > 1).length;
    const noTest = [...plan.tasks.values()].filter((t) => !t.acceptance?.length).length;
    const forward = problems.filter((p) => /in a later milestone/.test(p.message)).length;
    const next = v.board.milestones.find((m) => !m.reached);
    return {
      file: !!ts,
      revision: ts?.revision,
      lanes: ts?.lanes.length ?? 0,
      epics: ts?.epics.size ?? 0,
      features: ts?.features.size ?? 0,
      stories: ts?.stories.size ?? 0,
      tasks: plan.tasks.size,
      human: plan.human.size,
      deps: [...plan.tasks.values()].reduce((n, t) => n + t.blocked_by.length, 0),
      critical: v.board.criticalPath.length,
      problems: problems.length,
      milestones: { count: v.board.milestones.length, reached: v.board.milestones.filter((m) => m.reached).length, next: next && { title: next.title, at: next.at }, placeholders: [...plan.tasks.values()].filter((t) => t.placeholder_for?.length).length },
      checks: [
        ts
          ? { ok: !v.board.unplaced.length, text: v.board.unplaced.length ? `${v.board.unplaced.length} tasks name a story the TaskSet doesn't declare` : 'Every task sits in a story, feature, epic and lane' }
          : { ok: false, text: 'No version 2 TaskSet in .helix/plan/taskset.yaml: helix-loop validate says why' },
        plan.milestones
          ? { ok: !forward, text: forward ? `${forward} dependencies point to a later milestone` : 'Every task is in a milestone, and none waits on a later one' }
          : { ok: false, text: 'No Helix Milestones yet: the loop runs only a plan with a delivery order' },
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
    const r = await ops.humanAction(root, id, {
      status: body.status === undefined ? undefined : String(body.status),
      steps: Array.isArray(body.steps) ? body.steps.map(Number) : undefined,
      snooze: typeof body.snooze === 'string' ? body.snooze : undefined,
      evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
    }, ACTOR());
    // Done: Helix's monitor adds what builders need from it (an ID, never a secret) to the tasks waiting on it.
    if (r.change && body.status === 'done' && monitorOn()) helix.watch(root, `human:${id}`);
    return r;
  }

  // A builder's report_issue under a Pause or Notify rule (spec §10): its pass stops at once and the task waits
  // for the owner, or a notification goes out.
  function onFeedback(task: string) {
    const r = readReports(roots.real).findLast((x) => x.task === task && x.kind === 'issue');
    if (!r || Date.now() - Date.parse(r.at) > 5000) return;
    const kind = (({ plan_problem: 'scope_grew', flake: 'flaky_test' }) as Record<string, string>)[r.issue ?? ''] ?? r.issue;
    if (!(FEEDBACK_KINDS as readonly string[]).includes(kind ?? '')) return;
    const rule = feedbackRule(loadConfig(roots.real), kind as FeedbackKind, snap('real').plan.tasks.get(task)?.repo);
    if (rule.pause) ops.writeStopRequest(roots.real, task, { to: 'needs_human', why: `${kind!.replace('_', ' ')}: ${r.message.slice(0, 200)}` });
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
    const r = await ops.startLoop(opts.root, which, {
      agents: Array.isArray(body.agents) ? body.agents.filter((a: string) => (AGENTS as readonly string[]).includes(a)) : [],
      maxPasses: Number(body.maxPasses),
      configChanges: Array.isArray(body.configChanges) ? body.configChanges : undefined,
      planChanges: Array.isArray(body.planChanges) ? body.planChanges : undefined,
    });
    changed(which, 'loop');
    return r;
  }

  async function commitDiff(root: string, repo: string, sha: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, 'not a commit');
    return (await exec('git', ['show', '--stat', '--patch', '--format=fuller', sha], { cwd: join(paths(root).repos, ops.repoArg(loadConfig(root), repo)), maxBuffer: 20_000_000 })).stdout.slice(0, 1_500_000);
  }

  async function releaseFiles(root: string, repo: string, tag: string) {
    const a = pendingApprovals(paths(root).approvals, ops.repoArg(loadConfig(root), repo)).find((x) => x.approval.tag === tag)?.approval;
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
    const a = pendingApprovals(paths(root).approvals, ops.repoArg(loadConfig(root), repo)).find((x) => x.approval.tag === tag)?.approval;
    if (!a) throw new HttpError(404, `${repo} ${tag} is not waiting for approval`);
    if (!file || file.includes('..')) throw new HttpError(400, 'not a file');
    return (await exec('git', ['diff', a.since, a.commit, '--', file], { cwd: join(paths(root).repos, repo), maxBuffer: 20_000_000 })).stdout.slice(0, 1_000_000);
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

// Kept here too for the callers that read a human task's steps from the server's module.
export { stepsOf } from '../ops/plan.ts';

// Failures per hour over the incident's span, at most three days back, for its chart.
function hourly(times: number[], now: number): { start: number; counts: number[] } {
  if (!times.length) return { start: now, counts: [] };
  const start = Math.max(Math.min(...times), now - 3 * 86_400_000);
  const n = Math.max(1, Math.ceil((now - start) / 3_600_000));
  const counts = new Array(n).fill(0) as number[];
  for (const t of times) if (t >= start) counts[Math.min(n - 1, Math.floor((t - start) / 3_600_000))]!++;
  return { start, counts };
}

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
