import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

// The Helix skill (app spec §13.1): the guidelines any agent harness follows to write a Helix Spec and
// break it into a TaskSet this loop can run. Its source is skill/ in the control plane; the schemas are
// not kept there but copied in from plan/schema/ whenever the skill is packed or installed, so the skill
// never drifts from what the loop accepts.

// The folder the zip holds the skill under: an upload or an unzip into a skills directory gets one
// folder named for the skill, as harnesses expect.
const ZIP_ROOT = 'helix';

interface SkillFile {
  path: string; // inside the skill, with forward slashes
  source: string; // absolute path on disk
}

// Every file of the skill: skill/ (bar dotfiles and any stray schema/ copy), then plan/schema/*.json
// under schema/. Sorted, so a pack lists the same files in the same order every time.
function skillFiles(root: string): SkillFile[] {
  const skillDir = join(root, 'skill');
  if (!existsSync(join(skillDir, 'SKILL.md'))) throw new Error(`skill: ${skillDir} has no SKILL.md`);
  const files: SkillFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      const path = relative(skillDir, full).split(sep).join('/');
      if (path === 'schema') continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path, source: full });
    }
  };
  walk(skillDir);
  const schemaDir = join(root, 'schema');
  for (const name of readdirSync(schemaDir).sort()) {
    if (name.endsWith('.json')) files.push({ path: `schema/${name}`, source: join(schemaDir, name) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// The version in SKILL.md's frontmatter (`version: 1.0`, usually under `metadata:`).
function skillVersion(root: string): string {
  const text = readFileSync(join(root, 'skill', 'SKILL.md'), 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return /^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(front)?.[1] ?? 'unknown';
}

export function skillInfo(root: string): { version: string; bytes: number; files: string[] } {
  const files = skillFiles(root);
  return { version: skillVersion(root), bytes: zip(files).length, files: files.map((f) => f.path) };
}

// Builds helix-skill.zip: the skill and the current schemas, under one helix/ folder.
export async function packSkill(root: string, outFile: string): Promise<{ file: string; bytes: number; files: string[] }> {
  const files = skillFiles(root);
  const data = zip(files);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, data);
  return { file: outFile, bytes: data.length, files: files.map((f) => f.path) };
}

// Copies the same tree into a harness's skills directory (for example ~/.claude/skills/helix),
// creating it and overwriting what an earlier install left there.
export function installSkill(root: string, dir: string): { files: string[] } {
  const files = skillFiles(root);
  for (const f of files) {
    const to = join(dir, ...f.path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(f.source, to);
  }
  return { files: files.map((f) => f.path) };
}

// ---- A minimal ZIP writer (PKWARE APPNOTE 4.3): one local header and body per file, then the central
// directory and its end record. Deflated, or stored when deflating doesn't make a file smaller. No
// ZIP64, so the whole archive must stay under 4 GB, which a skill does by far.

function zip(files: SkillFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = readFileSync(f.source);
    const deflated = deflateRawSync(body, { level: 9 });
    const stored = deflated.length >= body.length;
    const data = stored ? body : deflated;
    const name = Buffer.from(`${ZIP_ROOT}/${f.path}`, 'utf8');
    const { time, date } = dosTime(statSync(f.source).mtime);
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8); // method: stored or deflated
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory header signature
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0, so the permissions below are read
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // 30 extra length, 32 comment length, 34 disk number, 36 internal attributes: all 0.
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    entry.writeUInt32LE(offset, 42);

    parts.push(local, name, data);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  // 4 this disk, 6 the directory's disk: both 0.
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  // 20 comment length: 0.
  return Buffer.concat([...parts, directory, end]);
}

// MS-DOS date and time, in local time as zip tools read them; two-second resolution, from 1980.
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
