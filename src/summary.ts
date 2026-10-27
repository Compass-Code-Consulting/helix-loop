// The dependency map's one-line note per task (Task.summary): what the last pass that changed the
// task's state did. Always under 144 characters, so it reads at a glance on the map.

export const SUMMARY_LIMIT = 144; // every summary is shorter than this

// One line of text, clipped at a word boundary with "…" when it would reach the limit. A single word
// too long to keep whole (a path, a URL) is cut where the room ends.
export function clipSummary(text: string, limit = SUMMARY_LIMIT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length < limit) return line;
  const room = limit - 2; // the kept text, plus "…", stays under the limit
  const space = line.lastIndexOf(' ', room);
  const head = space > room / 2 ? line.slice(0, space) : line.slice(0, room);
  return `${head.replace(/[\s,;:.]+$/, '')}…`;
}

// An attempt's note keeps at most this many characters; the next attempt's prompt reads it.
export const NOTE_LIMIT = 4000;

// A note cut to fit: its first line says what happened and its end is where tools print what failed,
// so a long note keeps both and loses its middle.
export function clipNote(text: string, limit = NOTE_LIMIT): string {
  if (text.length <= limit) return text;
  const gap = '\n[…]\n';
  const head = text.split('\n', 1)[0]!.slice(0, Math.floor(limit / 4));
  return `${head}${gap}${text.slice(text.length - (limit - head.length - gap.length))}`;
}

// The first line of a message that has any text.
export function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}
