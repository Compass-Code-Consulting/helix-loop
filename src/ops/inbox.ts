import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, paths, repoDir } from '../config.ts';
import { git } from '../git.ts';
import { readLedger } from '../ledger.ts';
import { loadPlan } from '../plan/store.ts';
import { run } from '../proc.ts';
import { addClarification, applyChanges } from '../app/fixes.ts';
import { appendHitl, readHitl } from '../app/hitl.ts';
import { appendStored, incidents as findIncidents, readStored, type Incident, type PlanChange } from '../app/incidents.ts';
import { readReports } from '../app/state.ts';
import { OpError, type Actor } from './actor.ts';
import { addRule } from './helix.ts';
import type { Applied } from './plan.ts';
import { repoArg } from './settings.ts';

// What waits on the owner (spec §6.3): a fix Helix proposed for an incident, questions one answer covers, a
// request Helix raised instead of deciding it, and a missing secret.

// The incidents as they stand: builder feedback and gate failures with one cause, grouped (app/incidents.ts).
export function incidentsNow(root: string, now = Date.now()): Incident[] {
  const p = paths(root);
  return findIncidents({ plan: loadPlan(p.tasks, p.human), events: existsSync(p.ledger) ? readLedger(p.ledger) : [], reports: readReports(root), stored: readStored(p.incidents), now });
}

// An incident by its key, its fix's id (F-3), or the start of its key when only one starts so: keys hold a
// failing test's title, which is long to type.
export function findIncident(incidents: Incident[], ref: string): Incident {
  const hit = incidents.find((i) => i.key === ref) ?? incidents.find((i) => i.fix?.id === ref);
  if (hit) return hit;
  const starts = incidents.filter((i) => i.key.startsWith(ref));
  if (starts.length === 1) return starts[0]!;
  throw new OpError(404, starts.length ? `${starts.length} incidents start with "${ref}": ${starts.slice(0, 4).map((i) => i.key).join(', ')}` : `no incident ${ref}`);
}

// Accept or decline the fix waiting for an incident. Accepted, its plan changes land as one commit you can undo.
export async function decideFix(root: string, ref: string, decision: 'accepted' | 'declined', actor: Actor, incidents?: Incident[]): Promise<Applied | { declined: string }> {
  const inc = findIncident(incidents ?? incidentsNow(root), ref);
  if (!inc.fix) throw new OpError(404, 'no fix waiting for that incident');
  if (inc.decision) throw new OpError(409, `${inc.fix.id} was ${inc.decision.decision} already`);
  if (decision === 'declined') {
    appendStored(paths(root).incidents, { type: 'decided', key: inc.key, at: new Date().toISOString(), fix: inc.fix.id, decision: 'declined' });
    return { declined: inc.fix.id };
  }
  const r = await applyChanges(root, inc.fix.changes, { what: inc.fix.summary, by: actor.by, where: actor.where, source: `fix ${inc.fix.id}` });
  appendStored(paths(root).incidents, { type: 'decided', key: inc.key, at: new Date().toISOString(), fix: inc.fix.id, decision: 'accepted', change: r.change?.id });
  return r;
}

// Answer once (spec §6.3): into the notes of every task asked (handing back those that wait), and optionally into
// the spec's clarifications and a rule that lets Helix answer the like itself. `home` is the real project, when
// `root` is its dry run.
export async function answerOnce(root: string, ref: string, text: string, o: { tasks?: string[]; notes?: boolean; spec?: boolean; rule?: boolean; home?: string }, actor: Actor, incidents?: Incident[]): Promise<{ applied?: Applied; clarification?: string; rule?: unknown }> {
  const answer = text.trim();
  if (answer.length < 8) throw new OpError(400, 'write the answer first');
  const home = o.home ?? root;
  const inc = findIncident(incidents ?? incidentsNow(root), ref);
  const key = inc.key;
  const tasks = o.tasks?.length ? o.tasks : inc.members.map((m) => m.task);
  const about = key.startsWith('spec:') ? key.slice(5) : inc.cause.slice(0, 40);
  const out: { applied?: Applied; clarification?: string; rule?: unknown } = {};
  if (o.notes !== false) {
    const plan = loadPlan(paths(root).tasks, paths(root).human);
    const open = tasks.filter((id) => ['ready', 'needs_human', 'parked'].includes(plan.tasks.get(id)?.status ?? ''));
    const changes: PlanChange[] = open.map((task) => ({ op: plan.tasks.get(task)!.status === 'ready' ? 'note' : 'hand_back', task, note: `Answer about ${about}: ${answer}` }) as PlanChange);
    out.applied = await applyChanges(root, changes, { what: `answer ${changes.length} question${changes.length === 1 ? '' : 's'} about ${about}`, by: actor.by, where: actor.where, source: `incident ${key}` });
  }
  if (o.spec) out.clarification = await addClarification(home, about, answer, tasks);
  if (o.rule) out.rule = await addRule(home, { name: `spec questions about ${about}`, request: 'spec_plain', decide: 'helix' }, actor);
  if (inc.fix) appendStored(paths(root).incidents, { type: 'decided', key, at: new Date().toISOString(), fix: inc.fix.id, decision: 'accepted' });
  return out;
}

// A request Helix raised instead of deciding (spec §7): the option picked, numbered from 0, lands as one commit.
export async function decideAsk(root: string, id: string, option: number, actor: Actor): Promise<Applied> {
  const r = readHitl(paths(root).hitl).raised.find((x) => x.id === id);
  if (!r) throw new OpError(404, `no request ${id}`);
  if (r.answered) throw new OpError(409, `${id} was decided already`);
  const o = r.options[option];
  if (!o) throw new OpError(400, 'pick one of its options');
  const applied = await applyChanges(root, o.changes, { what: `${o.label}: ${r.question.slice(0, 80)}`, by: actor.by, where: actor.where, source: id });
  appendHitl(paths(root).hitl, { type: 'answered', id, at: new Date().toISOString(), option });
  return applied;
}

// Add the secret (spec §6.3): the value goes straight to the keychain or GitHub, on standard input, and is never
// logged, stored or shown again. The tasks it stopped then go back to the loop.
export async function addSecret(root: string, s: { name: string; value: string; where?: 'keychain' | 'github'; repo?: string; env?: string; tasks?: string[] }, actor: Actor): Promise<{ saved: string; where: 'keychain' | 'github'; handed?: Applied }> {
  const name = s.name;
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) throw new OpError(400, 'a secret name is upper case, like STRIPE_TEST_KEY');
  const value = s.value;
  if (!value || /\n/.test(value) || value.length > 10_000) throw new OpError(400, 'paste the value on one line');
  // Whatever a tool says back, the value is taken out before it is shown.
  const hide = (t: string) => t.split(value).join('***').trim();
  if (s.where === 'github') {
    const repo = repoArg(loadConfig(root), s.repo);
    const remote = await git(repoDir(loadConfig(root), repo), 'remote', 'get-url', 'origin').catch(() => '');
    const slug = /github\.com[:/](.+?)(\.git)?$/.exec(remote)?.[1];
    if (!slug) throw new OpError(409, `${repo} has no GitHub remote`);
    const env = (s.env ?? '').trim();
    if (env && !/^[\w-]+$/.test(env)) throw new OpError(400, 'an environment name, like production');
    const r = await run('gh', ['secret', 'set', name, '--repo', slug, ...(env ? ['--env', env] : [])], { cwd: tmpdir(), stdin: value, timeoutMs: 60_000 });
    if (r.code !== 0) throw new OpError(409, `gh refused it: ${hide(r.stderr).slice(0, 300)}`);
  } else {
    const quote = (t: string) => `"${t.replace(/(["\\])/g, '\\$1')}"`;
    const r = await run('security', ['-i'], { cwd: tmpdir(), stdin: `add-generic-password -U -s ${quote(`Helix Loop: ${name}`)} -a ${quote(name)} -w ${quote(value)}\n`, timeoutMs: 20_000 });
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new OpError(409, `the keychain refused it: ${hide(r.stderr).slice(0, 200)}`);
  }
  const plan = loadPlan(paths(root).tasks, paths(root).human);
  const waiting = (s.tasks ?? []).filter((id) => ['needs_human', 'parked'].includes(plan.tasks.get(id)?.status ?? ''));
  const handed = waiting.length ? await applyChanges(root, waiting.map((task) => ({ op: 'hand_back', task, note: `${name} is set now.` }) as PlanChange), { what: `hand back ${waiting.length} task${waiting.length === 1 ? '' : 's'}: ${name} is set`, by: actor.by, where: actor.where }) : undefined;
  return { saved: name, where: s.where === 'github' ? 'github' : 'keychain', handed };
}
