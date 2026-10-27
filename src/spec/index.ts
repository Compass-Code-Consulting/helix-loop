import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Splits the canonical spec into one file per section and builds spec/index.json, which maps
// section keys and requirement IDs to text. The prompt renderer injects only what a task cites (L2).

export interface SectionEntry {
  key: string; // "§11", "§11 Composer", "§10.1", "App. D"
  title: string;
  file: string; // relative to spec/sections
  startLine: number; // 1-based, inclusive, within the section file
  endLine: number; // inclusive
}

export interface ReqEntry {
  id: string;
  section: string; // key of the enclosing ## section
  subsection: string | null; // key of the enclosing ### subsection
  file: string;
  startLine: number;
  endLine: number;
}

export interface SpecIndex {
  version: string;
  sections: Record<string, SectionEntry>;
  reqs: Record<string, ReqEntry>;
  glossary: string | null; // section key always injected
}

const REQ_DEF = /^(\s*)(?:[-*]|\d+\.)\s+\*\*([A-Z]{1,5}-\d+[a-z]?)\b/;
const H2 = /^## (.+)$/;
const H3 = /^### (.+)$/;

function sectionKey(title: string): { key: string; num: string | null } {
  const numbered = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(title);
  if (numbered) return { key: `§${numbered[1]}`, num: numbered[1]! };
  const appendix = /^Appendix ([A-Z])\b/.exec(title);
  if (appendix) return { key: `App. ${appendix[1]}`, num: null };
  return { key: title, num: null };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function buildIndex(specText: string): { index: SpecIndex; files: Map<string, string> } {
  const lines = specText.split('\n');
  // The version is the newest row of the Appendix B changelog, which lists newest first.
  const changelog = specText.slice(Math.max(0, specText.indexOf('## Appendix B')));
  const version = /^\| v(\d+\.\d+(?:\.\d+)?) \|/m.exec(changelog)?.[1] ?? 'unknown';
  const files = new Map<string, string>();
  const sections: Record<string, SectionEntry> = {};
  const reqs: Record<string, ReqEntry> = {};
  let glossary: string | null = null;

  // Find the ## boundaries.
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (H2.test(l)) starts.push(i);
  });

  starts.forEach((start, n) => {
    let end = (starts[n + 1] ?? lines.length) - 1;
    // A "# Part" heading belongs to no section.
    for (let i = start + 1; i <= end; i++) {
      if (/^# /.test(lines[i]!)) {
        end = i - 1;
        break;
      }
    }
    const title = H2.exec(lines[start]!)![1]!.trim();
    const { key, num } = sectionKey(title);
    const bare = title.replace(/^[\d.]+\s*/, '').replace(/^Appendix [A-Z]\.\s*/, '');
    const file = `${num !== null ? num.padStart(2, '0') : slug(key)}-${slug(bare)}.md`;
    const body = lines.slice(start, end + 1);
    while (body.length && body[body.length - 1]!.trim() === '') body.pop();
    files.set(file, body.join('\n') + '\n');
    sections[key] = { key, title, file, startLine: 1, endLine: body.length };
    if (/^glossary$/i.test(title.replace(/^[\d.]+\s*/, ''))) glossary = key;

    // ### subsections within it.
    const subs: number[] = [];
    body.forEach((l, i) => {
      if (H3.test(l)) subs.push(i);
    });
    subs.forEach((s, m) => {
      const subTitle = H3.exec(body[s]!)![1]!.trim();
      const subEnd = (subs[m + 1] ?? body.length) - 1;
      const entry = { title: subTitle, file, startLine: s + 1, endLine: subEnd + 1 };
      const subNum = /^(\d+\.\d+)\s+(.*)$/.exec(subTitle);
      const named = `${key} ${subNum ? subNum[2] : subTitle}`;
      sections[named] = { key: named, ...entry };
      if (subNum) sections[`§${subNum[1]}`] = { key: `§${subNum[1]}`, ...entry };
    });

    // Requirement definitions: a list item that opens with the bold ID.
    body.forEach((l, i) => {
      const m = REQ_DEF.exec(l);
      if (!m) return;
      const indent = m[1]!.length;
      let last = i;
      for (let j = i + 1; j < body.length; j++) {
        const line = body[j]!;
        if (line.trim() === '') continue;
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent <= indent || /^#/.test(line)) break;
        last = j;
      }
      const sub = subs.filter((s) => s <= i).pop();
      let subsection: string | null = null;
      if (sub !== undefined) {
        const subTitle = H3.exec(body[sub]!)![1]!.trim();
        const subNum = /^(\d+\.\d+)\s+(.*)$/.exec(subTitle);
        subsection = `${key} ${subNum ? subNum[2] : subTitle}`;
      }
      const id = m[2]!;
      if (reqs[id]) throw new Error(`spec: ${id} is defined twice (${reqs[id].file}:${reqs[id].startLine} and ${file}:${i + 1})`);
      reqs[id] = { id, section: key, subsection, file, startLine: i + 1, endLine: last + 1 };
    });
  });

  return { index: { version, sections, reqs, glossary }, files };
}

// Regenerates spec/sections and spec/index.json. Never hand-edit either.
export function writeIndex(specPath: string, sectionsDir: string, indexPath: string): SpecIndex {
  const { index, files } = buildIndex(readFileSync(specPath, 'utf8'));
  rmSync(sectionsDir, { recursive: true, force: true });
  mkdirSync(sectionsDir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(sectionsDir, name), text);
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  return index;
}

export function loadIndex(indexPath: string): SpecIndex {
  return JSON.parse(readFileSync(indexPath, 'utf8')) as SpecIndex;
}

export function sectionFiles(sectionsDir: string): string[] {
  return readdirSync(sectionsDir).filter((f) => f.endsWith('.md'));
}

// Resolves a task's spec citation to a section key, case-insensitively.
export function resolveSection(index: SpecIndex, cite: string): SectionEntry | undefined {
  const want = cite.trim().toLowerCase();
  return Object.values(index.sections).find((s) => s.key.toLowerCase() === want);
}

export function sliceSection(sectionsDir: string, e: { file: string; startLine: number; endLine: number }): string {
  const lines = readFileSync(join(sectionsDir, e.file), 'utf8').split('\n');
  return lines.slice(e.startLine - 1, e.endLine).join('\n');
}
