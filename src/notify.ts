import { execFile } from 'node:child_process';

// Tells Daniel when the loop needs him or has stopped: a pause, an exit, a harness error.
// Delivery failures never stop the loop.

export type Notifier = (title: string, message: string) => void;

export function macNotifier(enabled: boolean): Notifier {
  return (title, message) => {
    if (!enabled || process.platform !== 'darwin') return;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], () => {});
  };
}

export const silentNotifier: Notifier = () => {};
