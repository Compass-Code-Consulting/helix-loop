#!/usr/bin/env node
// helix-loop: the CLI. Every command is declared in src/cli/commands/; `helix-loop --help` lists them.
import { main } from '../src/cli/main.ts';

process.exitCode = await main(process.argv.slice(2));
