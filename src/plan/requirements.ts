import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { paths } from '../config.ts';

// The two requirement lists beside the TaskSet: synthetic requirements, for what the spec describes only in prose
// (a screen, a formula, a template), and deferred ones, which the spec names but the plan leaves for later.
// Coverage checks every spec requirement and every synthetic one is claimed by a task, unless deferred.

export interface Synthetic {
  id: string;
  title: string;
  source: string; // the spec section it comes from
}

// A file being rewritten reads as empty here; validation reports a broken one through its own checks.
const readList = <T>(file: string): T[] => {
  if (!existsSync(file)) return [];
  try {
    const v = parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

export const loadSynthetic = (root: string): Synthetic[] => readList<Synthetic>(paths(root).syntheticReqs);
export const loadDeferred = (root: string): Set<string> => new Set(readList<{ id: string }>(paths(root).deferredReqs).map((d) => d.id));
