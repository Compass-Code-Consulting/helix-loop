import { resolve } from 'node:path';
import { startApp } from '../app/server.ts';
import { loadConfig } from '../config.ts';

// The app, from the CLI, for what only the app does: a Helix turn needs the app's MCP endpoint, and Helix's
// monitor runs inside it. The app this project runs is found on its configured port and asked which project it
// serves; failing that, `ask` starts one in this process, with the monitor off, for as long as the question takes.

export interface AppClient {
  url: string;
  started: boolean; // started by this command, and closed when it is done
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  close(): Promise<void>;
}

async function client(url: string, started: boolean, close: () => Promise<void>): Promise<AppClient> {
  // The page carries the launch token every change needs; any process on this machine can read it, as the
  // page's own scripts do.
  const page = await (await fetch(`${url}/`)).text();
  const token = /name="helix-token" content="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error(`the app on ${url} gave no launch token`);
  const answer = async <T>(r: Response): Promise<T> => {
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `the app answered ${r.status}`);
    return body;
  };
  return {
    url,
    started,
    get: async (path) => answer(await fetch(`${url}${path}`)),
    post: async (path, body) => answer(await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-helix-token': token }, body: JSON.stringify(body) })),
    close,
  };
}

// The app serving this project, if one runs on the port its config names.
export async function runningApp(root: string): Promise<AppClient | undefined> {
  const port = loadConfig(root).app?.port ?? 47320;
  const url = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return undefined;
    const p = (await r.json()) as { root?: string };
    if (!p.root || resolve(p.root) !== resolve(root)) return undefined;
    return await client(url, false, async () => undefined);
  } catch {
    return undefined;
  }
}

// The running app, or one started here on a free port, with Helix's monitor off.
export async function appFor(root: string): Promise<AppClient> {
  const found = await runningApp(root);
  if (found) return found;
  const app = await startApp({ root, port: 0, monitor: false });
  return client(app.url, true, () => app.close());
}
