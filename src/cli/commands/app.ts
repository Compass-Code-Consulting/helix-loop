import { execFile } from 'node:child_process';
import { startApp } from '../../app/server.ts';
import { loadConfig } from '../../config.ts';
import { define, str } from '../command.ts';

// The app: the control room in the browser. Most of what it does has a command too; what doesn't (the Map,
// Live's grid, the charts) is visual.

const app = define({
  name: 'app',
  group: 'The app',
  summary: 'Open Helix Loop, the control room: Home, the Map, Live, Helix, the metrics, Settings',
  description: `Serves the app on http://127.0.0.1 (never another interface) and the MCP endpoints builders report to and Helix works through.
It runs until you stop it (Ctrl-C).
The loop runs on its own: either can restart without the other.`,
  options: {
    port: { type: 'string', value: 'N', description: 'The port, instead of the config\'s app.port (47320 by default)' },
    open: { type: 'boolean', description: 'Open it in the browser once it is up' },
  },
  async run({ root, opts, out }) {
    const port = str(opts, 'port') ? Number(str(opts, 'port')) : (loadConfig(root).app?.port ?? 47320);
    const running = await startApp({ root, port });
    out(`Helix Loop on ${running.url}`);
    if (opts.open && process.platform === 'darwin') execFile('open', [running.url], () => {});
    await new Promise<void>((resolve) => {
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void running.close().then(resolve));
    });
  },
});

export const APP_COMMANDS = [app];
