import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedJson } from '../map/render.ts';
import { atomicWrite } from '../plan/store.ts';
import type { MetricsModel } from './model.ts';
import { renderIndex, renderMetrics } from './render.ts';

// The metrics page is kept as a history (runs/metrics/): a new version every N passes, each left as it was
// written, so how the build changes over time stays visible. Every version links to the others. The list it
// was written with is in the page, and versions.js, rewritten with each new version, lets an older page link
// to newer ones too: a page opened from disk can still load a plain script beside it. index.html lists them all.

export const VERSION_EVERY = 100;

export interface MetricsVersion {
  file: string;
  at: number;
  passes: number;
  done: number;
  total: number;
  finish?: number;
  rate24: number;
  mergeRate24?: number;
  costPerTask24?: number;
}

export function readVersions(dir: string): MetricsVersion[] {
  try {
    return JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')) as MetricsVersion[];
  } catch {
    return [];
  }
}

// Writes the model as a new version, named for its local date and the passes so far; a version with the same
// name is replaced. Returns what the index records about it.
export function writeVersion(dir: string, model: MetricsModel, every = VERSION_EVERY): MetricsVersion {
  mkdirSync(dir, { recursive: true });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: model.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(model.generatedAt);
  const file = `Metrics.${day}.${String(model.passCount).padStart(4, '0')}.html`;
  const version: MetricsVersion = {
    file,
    at: model.generatedAt,
    passes: model.passCount,
    done: model.kpi.done,
    total: model.kpi.total,
    finish: model.projection.finish,
    rate24: model.kpi.rate24,
    mergeRate24: model.kpi.mergeRate24,
    costPerTask24: model.kpi.costPerTask24,
  };
  const versions = [...readVersions(dir).filter((v) => v.file !== file), version].sort((a, b) => a.at - b.at);
  atomicWrite(join(dir, file), renderMetrics({ ...model, file, versions, versionEvery: every }));
  atomicWrite(join(dir, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  atomicWrite(join(dir, 'versions.js'), `window.HELIX_METRICS_VERSIONS = ${embedJson(versions)};\n`);
  atomicWrite(join(dir, 'index.html'), renderIndex(versions, model.timeZone, every, model.product));
  return version;
}
