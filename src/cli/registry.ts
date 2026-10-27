import type { Command } from './command.ts';
import { APP_COMMANDS } from './commands/app.ts';
import { HELIX_COMMANDS } from './commands/helix.ts';
import { HUMAN_COMMANDS } from './commands/human.ts';
import { INBOX_COMMANDS } from './commands/inbox.ts';
import { LOOP_COMMANDS } from './commands/loop.ts';
import { PASS_COMMANDS } from './commands/passes.ts';
import { PLAN_COMMANDS } from './commands/plan.ts';
import { RELEASE_COMMANDS } from './commands/releases.ts';
import { SETTINGS_COMMANDS } from './commands/settings.ts';
import { SETUP_COMMANDS } from './commands/setup.ts';
import { TASK_COMMANDS } from './commands/tasks.ts';

// Every command, in the order the help lists them within their groups.
export const COMMANDS: Command[] = [
  ...SETUP_COMMANDS,
  ...PLAN_COMMANDS,
  ...LOOP_COMMANDS,
  ...PASS_COMMANDS,
  ...TASK_COMMANDS,
  ...HUMAN_COMMANDS,
  ...INBOX_COMMANDS,
  ...HELIX_COMMANDS,
  ...SETTINGS_COMMANDS,
  ...RELEASE_COMMANDS,
  ...APP_COMMANDS,
];
