import { setTimeout as delay } from 'node:timers/promises';

// Time is injected everywhere so the dry run can fast-forward through session-limit waits
// and the tests can simulate a host suspension.
export interface Clock {
  now(): number; // wall clock, ms since epoch
  monotonic(): number; // ms, never jumps
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: async (ms, signal) => {
    if (ms <= 0) return;
    try {
      await delay(ms, undefined, { signal });
    } catch (e) {
      if (!signal?.aborted) throw e;
    }
  },
};

// A clock that runs `scale` times faster than real time, for the dry run: an hour-long session
// limit passes in seconds. Everything the loop measures (waits, reset times, pass durations) uses
// the same accelerated time, so real child processes running alongside a wait stay consistent.
export class VirtualClock implements Clock {
  private readonly real0 = Date.now();
  private readonly perf0 = performance.now();
  private readonly wall0: number;
  private wallOffset = 0;
  readonly scale: number;
  constructor(scale = 1000, startAt = Date.now()) {
    this.scale = scale;
    this.wall0 = startAt;
  }
  now(): number {
    return this.wall0 + (Date.now() - this.real0) * this.scale + this.wallOffset;
  }
  monotonic(): number {
    return (performance.now() - this.perf0) * this.scale;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return systemClock.sleep(Math.max(0, ms) / this.scale, signal);
  }
  // Moves only the wall clock, which is what a host suspension looks like to a pass.
  jumpWall(ms: number): void {
    this.wallOffset += ms;
  }
}

// Measures a span and says whether the host slept during it. On macOS the monotonic clock
// (mach_absolute_time) stops while the machine sleeps, so the gap is the time asleep.
export function suspensionWatch(clock: Clock, thresholdMs: number): () => boolean {
  const wall0 = clock.now();
  const mono0 = clock.monotonic();
  return () => clock.now() - wall0 - (clock.monotonic() - mono0) > thresholdMs;
}
