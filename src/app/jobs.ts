import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A command the page started and is watching: one of the CLI's own commands (a release, an approval, an
// export), an install or a sign-in. Its output streams to the page as it arrives; the last 64 KB are kept.

export interface Job {
  id: string;
  title: string;
  command: string; // as shown to Daniel before he confirmed it
  status: 'running' | 'done' | 'failed';
  code?: number | null;
  output: string;
  startedAt: string;
  endedAt?: string;
  urls: string[]; // links the command printed, such as a sign-in page
}

const KEEP = 64 * 1024;
const shown = (cmd: string, args: string[]) => [cmd, ...args].map((a) => (/^[\w./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

export class Jobs {
  private jobs = new Map<string, Job>();
  private onChange: (job: Job) => void;

  constructor(onChange: (job: Job) => void) {
    this.onChange = onChange;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  start(title: string, cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; label?: string; onExit?: (job: Job) => void }): Job {
    const job: Job = { id: randomUUID(), title, command: opts.label ?? shown(cmd, args), status: 'running', output: '', startedAt: new Date().toISOString(), urls: [] };
    this.jobs.set(job.id, job);
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.finish(job, null, `could not start: ${(e as Error).message}\n`, opts.onExit);
      return job;
    }
    let pending: NodeJS.Timeout | undefined;
    const add = (d: Buffer) => {
      job.output = (job.output + d.toString()).slice(-KEEP);
      for (const u of job.output.match(/https?:\/\/[^\s"'<>]+/g) ?? []) if (!job.urls.includes(u)) job.urls.push(u);
      pending ??= setTimeout(() => {
        pending = undefined;
        this.onChange(job);
      }, 200);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => this.finish(job, null, `\n${e.message}\n`, opts.onExit));
    child.on('close', (code) => {
      if (pending) clearTimeout(pending);
      this.finish(job, code, '', opts.onExit);
    });
    child.stdin.end(opts.stdin ?? '');
    this.onChange(job);
    return job;
  }

  private finish(job: Job, code: number | null, extra: string, onExit?: (job: Job) => void): void {
    if (job.status !== 'running') return;
    job.output = (job.output + extra).slice(-KEEP);
    job.code = code;
    job.status = code === 0 ? 'done' : 'failed';
    job.endedAt = new Date().toISOString();
    onExit?.(job);
    this.onChange(job);
  }
}
