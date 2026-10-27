import type { Command } from './command.ts';
import { APP_COMMANDS } from './commands/app.ts';
import { LOOP_COMMANDS } from './commands/loop.ts';
import { PLAN_COMMANDS } from './commands/plan.ts';
import { RELEASE_COMMANDS } from './commands/releases.ts';
import { SETUP_COMMANDS } from './commands/setup.ts';

// Every command, in the order the help lists them within their groups.
export const COMMANDS: Command[] = [...SETUP_COMMANDS, ...PLAN_COMMANDS, ...LOOP_COMMANDS, ...RELEASE_COMMANDS, ...APP_COMMANDS];
