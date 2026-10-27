import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPaths } from '../src/gate.ts';

// Forbidden paths: secrets files never land, at any depth; the committed template of environment variables may.

test('gate: .env files are refused anywhere, .env.example is allowed anywhere', () => {
  const forbidden = ['**/.env', '**/.env.*', '.claude/**'];
  const allowed = ['**/.env.example'];
  const changed = ['.env', '.env.local', 'apps/api/.env.production', '.env.example', 'apps/api/.env.example', '.claude/settings.json', 'src/env.ts'];
  assert.deepEqual(forbiddenPaths(changed, forbidden, allowed), ['.env', '.env.local', 'apps/api/.env.production', '.claude/settings.json']);
  assert.deepEqual(forbiddenPaths(['.env.example'], forbidden, []), ['.env.example'], 'without the exception the template is refused, as it was');
});
