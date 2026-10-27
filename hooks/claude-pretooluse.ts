// PreToolUse hook for Claude Code loop passes. Rules enforced at the tool layer, not in the prompt:
//   - no background commands (L7): when the turn ends the pass ends, and nothing would read the result;
//   - file tools write only inside the pass's worktree: the plan, spec and harness are out of reach.
// Reads the hook event on stdin; prints a deny decision, or nothing to let the call proceed.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

interface HookEvent {
  cwd: string;
  tool_name: string;
  tool_input: { run_in_background?: boolean; file_path?: string; notebook_path?: string };
}

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

// Resolves symlinks in the longest existing prefix, so a link inside the worktree cannot point out of it.
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : resolve(real(parent), p.slice(parent.length + 1));
  }
}

const event = JSON.parse(readFileSync(0, 'utf8')) as HookEvent;
const root = process.env.MUSHY_WORKTREE ?? event.cwd;

if (event.tool_name === 'Bash' && event.tool_input.run_in_background) {
  deny('Background commands are disabled in the loop. Run the command in the foreground with a long enough timeout and wait for it.');
} else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.tool_name)) {
  const target = event.tool_input.file_path ?? event.tool_input.notebook_path ?? '';
  const abs = real(isAbsolute(target) ? target : resolve(event.cwd, target));
  const rel = relative(real(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) deny(`Writes outside this task's worktree are not allowed (${target}). Work only inside ${root}.`);
}
