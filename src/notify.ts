import { execFile } from 'node:child_process';

// Tells the owner when the loop needs them or has stopped: a pause, an exit, a harness error. Each title starts
// with the product's name, so two projects' loops can be told apart.
// Delivery failures never stop the loop.

export type Notifier = (title: string, message: string) => void;

export function macNotifier(enabled: boolean, product?: string): Notifier {
  return (bare, message) => {
    if (!enabled || process.platform !== 'darwin') return;
    const title = product ? `${product}: ${bare}` : bare;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`], () => {});
  };
}

export const silentNotifier: Notifier = () => {};
