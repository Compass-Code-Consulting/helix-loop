import { createInterface, type Interface } from 'node:readline/promises';

// Questions for a person at a terminal, for the wizards (init, skill install). Each has a default, shown in
// brackets and taken on Enter, so a wizard can be walked through quickly; scripts pass flags instead.

export class Asker {
  private rl: Interface;
  constructor(input = process.stdin, output = process.stdout) {
    this.rl = createInterface({ input, output });
  }

  async text(question: string, fallback = ''): Promise<string> {
    const a = (await this.rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return a || fallback;
  }

  async yes(question: string, fallback = true): Promise<boolean> {
    const a = (await this.rl.question(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    return a ? a.startsWith('y') : fallback;
  }

  // One of a few options, by number or by its first word.
  async choose<T extends string>(question: string, options: [T, string][], fallback: T): Promise<T> {
    const lines = options.map(([key, label], i) => `  ${i + 1}) ${label}${key === fallback ? ' (default)' : ''}`);
    for (;;) {
      const a = (await this.rl.question(`${question}\n${lines.join('\n')}\n> `)).trim().toLowerCase();
      if (!a) return fallback;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]![0];
      const hit = options.find(([key, label]) => key.toLowerCase() === a || label.toLowerCase().startsWith(a));
      if (hit) return hit[0];
    }
  }

  close(): void {
    this.rl.close();
  }
}
