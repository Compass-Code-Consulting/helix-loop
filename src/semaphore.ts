// At most `limit` holders at once; the rest wait their turn, first come first served. The loop runs several
// passes per agent, but the machine runs only so many gates and browser-test runs before they slow each other
// down and time out.
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  get busy(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // handed the holder's place
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
