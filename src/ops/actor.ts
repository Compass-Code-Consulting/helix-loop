import { ownerOf } from '../app/prompts.ts';

// The operations layer (src/ops/): every action a person can take on a project, as plain functions of the
// project's root, shared by the app's handlers and the CLI's commands. Each checks what it is given, changes the
// files, and returns what changed; neither caller holds logic of its own. The app adds what only it has (its
// change stream, Helix's turns); the CLI adds its output.

// Who changes something, and from where. Commit messages and the undo list say both, so the history shows
// whether a change was made in the app or with the CLI.
export interface Actor {
  by: string; // the project's owner, by name
  where: string; // "in Helix Loop" or "with helix-loop"
}

export const inApp = (root: string): Actor => ({ by: ownerOf(root), where: 'in Helix Loop' });
export const withCli = (root: string): Actor => ({ by: ownerOf(root), where: 'with helix-loop' });
export const signed = (a: Actor) => `${a.by}, ${a.where}`;

// A refusal the person can act on, said plainly. The app answers it with its status; the CLI prints it.
export class OpError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}
