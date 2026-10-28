import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { validateSchemas } from '../src/plan/validate.ts';
import { installSkill, packSkill, skillInfo } from '../src/skill.ts';

// The Helix skill (app spec §13.1): its validator agrees with the loop, its example is a valid TaskSet,
// and the pack and install carry the skill with the loop's current schemas.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const validator = join(root, 'skill', 'scripts', 'validate.mjs');
const example = join(root, 'skill', 'examples', 'mini-taskset');
const schemaDir = join(root, 'schema');
const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

function validate(planDir: string, ...args: string[]): { code: number; lines: string[] } {
  const r = spawnSync(process.execPath, [validator, planDir, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, lines: r.stdout.trim().split('\n') };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'helix-skill-'));
}

interface Reader {
  parseYaml: (text: string, source?: string) => unknown;
}
const reader = async () => (await import(pathToFileURL(validator).href)) as Reader;

// A project's own plan is the best corpus: HELIX_CORPUS names a plan folder to read every file of, as well.
test('skill: the validator reads every task and human task exactly as the yaml package does', async () => {
  const { parseYaml } = await reader();
  const plans = [example, ...(process.env.HELIX_CORPUS ? [process.env.HELIX_CORPUS] : [])];
  for (const [plan, dir] of plans.flatMap((p) => ['tasks', 'human'].map((d) => [p, d] as const))) {
    for (const f of readdirSync(join(plan, dir))) {
      const text = readFileSync(join(plan, dir, f), 'utf8');
      assert.deepEqual(parseYaml(text, f), parse(text), f);
    }
  }
});

test('skill: the validator reads the YAML a person writes by hand: flow maps, compact sequences, comments, folded text', async () => {
  const { parseYaml } = await reader();
  const text = [
    '--- # a TaskSet file',
    'id: T-0001   # the id',
    'blocked_by: [T-0002, "HT-3"]',
    'secrets:',
    '- { name: KEY, stored_in: "CI env: prod" }',
    '- name: OTHER',
    '  stored_in: keychain',
    'map: {a: 1, b: [x, y], c: null}',
    'multi: [one,',
    '  two]',
    'est: 0.5',
    'flag: true',
    'empty:',
    'url: https://example.com/a#b',
    "single: 'it''s'",
    'plain: a long title',
    '  that continues',
    'folded: >-',
    '  one',
    '  two',
    '',
    '  three',
    '',
    '',
    '  four',
    '    indented',
    '  five',
    'quoted: "a quoted',
    '  line\\ ',
    '  that folds"',
    'kept: |+',
    '  line',
    '',
    'nested:',
    '  - - a',
    '    - b',
    '  - k: v',
    '    list:',
    '    - 1',
  ].join('\n');
  assert.deepEqual(parseYaml(text), parse(text));
  assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), /anchors, aliases and tags/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key "a"/);
});

test('skill: the example TaskSet is valid, for the skill validator and for the loop schemas', () => {
  const r = validate(example);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(r.lines, ['10 tasks, 2 human tasks, 0 errors, 0 warnings']);

  assert.deepEqual(validateSchemas(schemaDir, join(example, 'tasks'), join(example, 'human')), []);
  const ajv = new Ajv({ allErrors: true });
  const check = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'taskset.schema.json'), 'utf8')));
  assert.ok(check(parse(readFileSync(join(example, 'taskset.yaml'), 'utf8'))), JSON.stringify(check.errors));
  const ms = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'milestones.schema.json'), 'utf8')));
  assert.ok(ms(parse(readFileSync(join(example, 'milestones.yaml'), 'utf8'))), JSON.stringify(ms.errors));
  // Each task names its story; one is built against a placeholder, and another wires it in.
  for (const f of readdirSync(join(example, 'tasks'))) assert.match(readFileSync(join(example, 'tasks', f), 'utf8'), /^story: [a-z-]+$/m);
  assert.match(readFileSync(join(example, 'tasks', 'T-0007.yaml'), 'utf8'), /^placeholder_for: \[T-0003\]$/m);
  assert.match(readFileSync(join(example, 'tasks', 'T-0010.yaml'), 'utf8'), /^wires: \[T-0007\]$/m);
});

test('skill: the validator and the loop agree on the fixture project\'s plan, and on a version 1 TaskSet', () => {
  assert.deepEqual(validate(join(root, 'test', 'fixtures', 'project', '.helix', 'plan')).lines, ['40 tasks, 3 human tasks, 0 errors, 0 warnings']);
  const dir = scratch();
  try {
    cpSync(example, dir, { recursive: true });
    writeFileSync(join(dir, 'taskset.yaml'), 'version: 1\nstages: [day0]\nlanes:\n  app:\n    repo: acme-app\n    epics:\n      core: { title: The core, stage: day0 }\n');
    for (const f of readdirSync(join(dir, 'tasks'))) {
      const t = join(dir, 'tasks', f);
      writeFileSync(t, readFileSync(t, 'utf8').replace(/^story: .*$/m, 'epic: core\nstage: day0'));
    }
    const r = validate(dir);
    assert.equal(r.code, 1);
    const loop = validateSchemas(schemaDir, join(dir, 'tasks'), join(dir, 'human')).map((p) => `${p.id}: ${p.message}`);
    assert.deepEqual(r.lines.filter((l) => l.startsWith('taskset.yaml')), loop);
    assert.match(loop[0]!, /^taskset\.yaml: is a version 1 TaskSet .* docs\/migrating\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: the milestones: every task in one, nothing waiting on a later one, each placeholder wired in once', () => {
  const dir = scratch();
  try {
    cpSync(example, dir, { recursive: true });
    const edit = (file: string, from: string | RegExp, to: string) => writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').replace(from, to));
    edit('tasks/T-0007.yaml', 'placeholder_for: [T-0003]\n', '');
    edit('tasks/T-0007.yaml', 'blocked_by: [T-0006]', 'blocked_by: [T-0006, T-0003]');
    edit('milestones.yaml', '    features: [confirmed-signups]\n', '');
    const r = validate(dir);
    const has = (line: string) => assert.ok(r.lines.includes(line), `missing "${line}" in:\n${r.lines.join('\n')}`);
    has('T-0007: waits on T-0003, which is in a later milestone (Addresses are confirmed, and joining is fair, after A visitor joins the waitlist): pull T-0003 forward, or build T-0007 against a placeholder (placeholder_for: [T-0003]) with a wiring task in confirmed-and-fair or later');
    has('T-0010: wires T-0007, which has no placeholder_for');
    has('T-0004: is in no milestone: name its feature, its story (export-csv) or the task itself in milestones.yaml');
    has('export: warning: milestone has no tasks: what it names belongs to more specific milestones');
    // Before milestones are planned, the TaskSet is fine, and says what comes next.
    const r1 = scratch();
    cpSync(example, r1, { recursive: true });
    rmSync(join(r1, 'milestones.yaml'));
    writeFileSync(join(r1, 'taskset.yaml'), readFileSync(join(r1, 'taskset.yaml'), 'utf8').replace('milestones: milestones.yaml\n', '').replace('revision: 2', 'revision: 1'));
    const plain = validate(r1);
    assert.equal(plain.code, 0, plain.lines.join('\n'));
    assert.ok(plain.lines.includes('milestones.yaml: warning: no milestones yet: plan the delivery order with /helix milestones; the loop runs only a plan with milestones'));
    rmSync(r1, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: a broken TaskSet fails with one line per problem', () => {
  const dir = scratch();
  try {
    cpSync(example, dir, { recursive: true });
    const edit = (file: string, from: RegExp, to: string) => {
      const f = join(dir, file);
      const text = readFileSync(f, 'utf8');
      assert.match(text, from, file);
      writeFileSync(f, text.replace(from, to));
    };
    edit('tasks/T-0001.yaml', /^blocked_by: \[\]$/m, 'blocked_by: [T-0004]'); // T-0001 → T-0004 → T-0002 → T-0001
    edit('tasks/T-0003.yaml', /^story: .*$/m, 'story: billing');
    edit('tasks/T-0007.yaml', /^estimate_passes: .*$/m, 'estimate_passes: 2');
    edit('tasks/T-0008.yaml', /^blocked_by: \[\]$/m, 'blocked_by: [T-0999]');
    edit('tasks/T-0006.yaml', /\[WL-6\] an invalid/, '[WL-7] an invalid');
    edit('human/HT-1.yaml', /^status: todo$/m, 'status: todo\nnotes: the key is sk_live_51Habcdefghijklmnopqrstu');

    const r = validate(dir);
    assert.equal(r.code, 1);
    const has = (line: string) => assert.ok(r.lines.includes(line), `missing "${line}" in:\n${r.lines.join('\n')}`);
    has('T-0001: dependency cycle: T-0001 → T-0004 → T-0002 → T-0001');
    has('T-0003: story billing is not declared in taskset.yaml');
    has('T-0007: warning: estimate_passes 2: more than one pass; split it unless splitting would leave something half-built');
    has('T-0008: blocked_by T-0999, which does not exist');
    has('T-0006: acceptance "e2e: [WL-7] an invalid address shows the field error next to the input and keeps what was typed" is tagged WL-7, which is not in the task\'s reqs');
    has('HT-1: holds what looks like a secret value; name the secret and where it is stored instead');
    assert.equal(r.lines.at(-1), '10 tasks, 2 human tasks, 7 errors, 1 warnings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: lanes, stories, schema and coverage problems are reported against the right ID', () => {
  const dir = scratch();
  try {
    cpSync(example, dir, { recursive: true });
    const t5 = join(dir, 'tasks', 'T-0005.yaml');
    writeFileSync(t5, readFileSync(t5, 'utf8').replace('repo: acme-app', 'repo: acme-docs').replace('estimate_passes: 0.5', 'estimate_passes: 4'));
    const t4 = join(dir, 'tasks', 'T-0004.yaml');
    writeFileSync(t4, readFileSync(t4, 'utf8').replace(/^story: .*\n/m, ''));
    writeFileSync(join(dir, 'reqs.txt'), `${readFileSync(join(dir, 'reqs.txt'), 'utf8')}WL-9 Something no task delivers\n`);
    writeFileSync(join(dir, 'tasks', 'T-0042.yaml'), readFileSync(join(dir, 'tasks', 'T-0003.yaml'), 'utf8'));
    const ts = join(dir, 'taskset.yaml');
    writeFileSync(ts, readFileSync(ts, 'utf8').replace('timelines: [code, project]', 'timelines: [code]'));
    const r = validate(dir);
    assert.equal(r.code, 1);
    for (const line of [
      'T-0005: builds acme-docs, but its story confirm-address is in lane app, which builds acme-app',
      'T-0005: schema: /estimate_passes must be <= 3',
      "T-0004: schema: / must have required property 'story'",
      'WL-9: no task delivers this requirement',
      'T-0003: is in T-0042.yaml; the file must be named T-0003.yaml',
      'T-0003: is defined twice',
      'taskset.yaml: schema: /timelines must be equal to one of the allowed values: ["code","project"], ["project"]',
    ]) {
      assert.ok(r.lines.includes(line), `missing "${line}" in:\n${r.lines.join('\n')}`);
    }
    // The schema's own maximum is reported once, not again by the size check.
    assert.equal(r.lines.filter((l) => l.startsWith('T-0005:') && l.includes('estimate_passes')).length, 1);

    rmSync(join(dir, 'taskset.yaml'));
    assert.ok(validate(dir).lines.includes('taskset.yaml: missing: a TaskSet declares its lanes, epics, features and stories in taskset.yaml'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: packSkill writes a zip that unzip accepts, holding the skill and the current schemas', { skip: !hasUnzip && 'no unzip on this machine' }, async () => {
  const dir = scratch();
  try {
    const out = join(dir, 'out', 'helix-skill.zip');
    const packed = await packSkill(root, out);
    assert.equal(packed.file, out);
    assert.equal(packed.bytes, readFileSync(out).length);
    const expected = [
      'SKILL.md',
      'guides/spec-technical.md',
      'guides/spec-design.md',
      'guides/decompose.md',
      'guides/atomic-tasks.md',
      'guides/human-tasks.md',
      'guides/milestones.md',
      'schema/task.schema.json',
      'schema/human.schema.json',
      'schema/taskset.schema.json',
      'schema/milestones.schema.json',
      'examples/mini-taskset/taskset.yaml',
      'examples/mini-taskset/milestones.yaml',
      'examples/mini-taskset/tasks/T-0001.yaml',
      'examples/mini-taskset/human/HT-1.yaml',
      'scripts/validate.mjs',
    ];
    for (const f of expected) assert.ok(packed.files.includes(f), f);

    assert.match(execFileSync('unzip', ['-t', out], { encoding: 'utf8' }), /No errors detected/);
    const listed = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listed, packed.files.map((f) => `helix/${f}`));
    // Byte for byte: the schema is the loop's, not a stale copy.
    assert.equal(execFileSync('unzip', ['-p', out, 'helix/schema/task.schema.json'], { encoding: 'utf8' }), readFileSync(join(schemaDir, 'task.schema.json'), 'utf8'));

    const info = skillInfo(root);
    assert.equal(info.version, '2.0');
    assert.deepEqual(info.files, packed.files);
    assert.equal(info.bytes, packed.bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill: installSkill copies the skill and its schemas, and the installed validator runs on its own', () => {
  const dir = scratch();
  try {
    const target = join(dir, 'skills', 'helix');
    writeFileSync(join(dir, 'placeholder'), '');
    const { files } = installSkill(root, target);
    for (const f of files) assert.ok(existsSync(join(target, f)), f);
    assert.ok(files.includes('schema/taskset.schema.json'));
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), readFileSync(join(root, 'skill', 'SKILL.md'), 'utf8'));

    // Installing again overwrites what is there.
    writeFileSync(join(target, 'SKILL.md'), 'stale');
    installSkill(root, target);
    assert.notEqual(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'stale');

    // The installed copy finds its own schema/, with no loop beside it.
    const r = spawnSync(process.execPath, [join(target, 'scripts', 'validate.mjs'), join(target, 'examples', 'mini-taskset')], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
