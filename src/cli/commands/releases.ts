import { join } from 'node:path';
import { loadConfig, paths } from '../../config.ts';
import { loadPlan } from '../../plan/store.ts';
import { approveRelease, describeBase, pendingApprovals, releaseRepo, releaseSettings, unreleased } from '../../release.ts';
import { define, UsageError } from '../command.ts';

// Releases: the loop tags them on its own (every N merged tasks, and when a stage closes); these cut one now,
// approve one held for review, and list what waits.

const repoOf = (root: string, repo: string) => {
  const config = loadConfig(root);
  if (!(repo in config.repos)) throw new UsageError(`No repo ${repo}: the project builds ${Object.keys(config.repos).join(', ')}.`);
  return config;
};

const list = define({
  name: 'releases',
  group: 'Releases',
  summary: 'What each repo has merged since its last release, and what waits for approval',
  json: true,
  run({ root, json, out }) {
    const p = paths(root);
    const config = loadConfig(root);
    const plan = loadPlan(p.tasks, p.human);
    const repos = Object.keys(config.repos).map((repo) => {
      const step = config.release.hold_until?.[repo];
      return { repo, unreleased: unreleased(p.ledger, repo).length, heldUntil: step && plan.human.get(step)?.status !== 'done' ? step : undefined };
    });
    const waiting = pendingApprovals(p.approvals).map((x) => x.approval);
    if (json) return out(JSON.stringify({ repos, waiting }, null, 2));
    for (const r of repos) out(`${r.repo}: ${r.unreleased} merged task${r.unreleased === 1 ? '' : 's'} not released yet${r.heldUntil ? `; held until ${r.heldUntil} is done` : ''}`);
    for (const a of waiting) {
      out(`${a.repo} ${a.tag} waits for approval: it changes ${a.paths.join(', ')} since ${describeBase(a.since)}`);
      out(`  review:  ${a.review}`);
      out(`  approve: helix-loop release approve ${a.repo} ${a.tag}`);
    }
  },
});

const cut = define({
  name: 'release run',
  group: 'Releases',
  summary: "Release a repo's main now, with the loop's holds",
  description: `Tags the repo's main as a release now, as the loop's own checkpoints do, and pushes the tag when push is on.
A release is held while the repo waits on a human task (release.hold_until), and one that changes a reviewed path (release.review_paths) waits for \`helix-loop release approve\`.
Exit codes: 0 released (or nothing new), 10 held until a person acts, 1 an error.`,
  args: [{ name: 'repo', description: 'The repo to release' }],
  async run({ root, args, out }) {
    const repo = args[0]!;
    const config = repoOf(root, repo);
    const p = paths(root);
    const plan = loadPlan(p.tasks, p.human);
    const r = await releaseRepo({ ...releaseSettings(config, p, repo), human: plan.human, now: Date.now(), reason: 'Released by hand', tasks: unreleased(p.ledger, repo).map((id) => ({ id, title: plan.tasks.get(id)?.title ?? '' })) });
    if (r.retried) out(`${r.retried.pushed ? 'Pushed' : 'Could not push'} ${r.retried.tags.join(', ')} to origin; an earlier push had failed.`);
    if (r.kind === 'current') {
      out(`${repo}: main (${r.commit.slice(0, 12)}) is already released as ${r.tag}; nothing new to release.`);
      return r.retried?.pushed === false ? 1 : 0;
    }
    if (r.kind === 'held') {
      out(`${repo} is not released: held ${r.detail}.`);
      out(`To lift the hold: ${r.clears}.`);
      return 10;
    }
    const pushed = r.pushed === true ? ' and pushed' : r.pushed === false ? ', but the push failed; it is pushed again before the next release, or run this again' : '; not pushed (push is off, or the repo has no origin)';
    out(`${repo} ${r.tag} is tagged at ${r.commit.slice(0, 12)}${pushed}.`);
    return r.pushed === false ? 1 : 0;
  },
});

const approve = define({
  name: 'release approve',
  group: 'Releases',
  summary: 'Tag and push a release held for review, once its diff is read',
  description: `A release that changes a reviewed path (CI workflows, infrastructure: what runs with production's secrets) waits in .helix/runs/approvals/.
\`helix-loop releases\` lists them with the command that shows the diff; this tags exactly the commit that was reviewed.`,
  args: [
    { name: 'repo', description: 'The repo' },
    { name: 'tag', description: 'The release tag, as `helix-loop releases` lists it' },
  ],
  async run({ root, args, out }) {
    const [repo, tag] = args as [string, string];
    const config = repoOf(root, repo);
    const p = paths(root);
    const r = await approveRelease({ repo, dir: join(p.repos, repo), tag, approvals: p.approvals, ledger: p.ledger, push: config.push, now: Date.now() });
    const at = r.approval.commit.slice(0, 12);
    if (r.pushed === false) {
      out(`${repo} ${tag} is approved and tagged at ${at}, but the push failed. It is pushed again before the repo's next release, or now with: helix-loop release run ${repo}`);
      return 1;
    }
    out(`${repo} ${tag} is tagged at ${at}${r.pushed === true ? ' and pushed' : '; not pushed (push is off, or the repo has no origin)'}.`);
  },
});

export const RELEASE_COMMANDS = [list, cut, approve];
