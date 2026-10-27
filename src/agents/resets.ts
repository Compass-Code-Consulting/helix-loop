// Reads the reset time out of a CLI's session-limit message. The formats come from real logs:
//   Claude: "You've hit your session limit · resets 11:40pm (America/Chicago)"
//           (weekly limits add a date: "resets Oct 25, 3pm (America/Chicago)")
//   Codex:  "... try again at 3:45 PM", "... try again in 2 hours 5 minutes",
//           "... try again at Oct 25th, 2026 3:45 PM"
// Returns epoch ms, or null when no time can be read (the loop then backs off).

const JUST_PAST_MS = 10 * 60_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseResetTime(message: string, now: number, defaultZone = localZone()): number | null {
  const rel = /try again in ((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)[\s,and]*)+)/i.exec(message);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1]!.matchAll(/(\d+)\s*(d|h|m|s)/gi)) {
      const k = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit!.toLowerCase() as 'd' | 'h' | 'm' | 's'];
      ms += Number(n) * k;
    }
    return ms > 0 ? now + ms : null;
  }

  const abs = /(?:resets|try again at)\s+(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i.exec(message);
  if (!abs) return null;
  const [, mon, day, year, hh, mm, ap, zone] = abs;
  let hour = Number(hh) % 12;
  if (ap!.toLowerCase() === 'p') hour += 12;
  const minute = Number(mm ?? 0);
  const tz = zone && isZone(zone) ? zone : defaultZone;

  const today = zonedParts(now, tz);
  if (mon && day) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return null;
    let y = year ? Number(year) : today.year;
    let t = zonedToEpoch(y, month, Number(day), hour, minute, tz);
    if (!year && t < now - 86_400_000) t = zonedToEpoch(++y, month, Number(day), hour, minute, tz);
    return t;
  }
  // A bare time means its next occurrence. Messages round to the minute, so a time just past means
  // the reset is due any moment (the probe came a few seconds early), not tomorrow.
  let t = zonedToEpoch(today.year, today.month, today.day, hour, minute, tz);
  if (t <= now - JUST_PAST_MS) t += 86_400_000;
  else if (t <= now) t = now + 60_000;
  return t;
}

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isZone(z: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(epoch: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(epoch).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

// Wall time in a zone → epoch, by correcting a UTC guess with the zone's offset at that instant.
export function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const offset = (e: number) => {
    const p = zonedParts(e, tz);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - e;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}
