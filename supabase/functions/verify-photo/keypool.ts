// A pool of Ollama API keys (up to 10, from different accounts) so one exhausted or revoked key does not stop photo review.
// Pure logic with no Deno APIs, so it can be tested with `node --experimental-strip-types`.

export const MAX_KEYS = 10;

/** `OLLAMA_API_KEYS` holds the keys separated by commas, spaces or new lines; the old single `OLLAMA_API_KEY` still works. */
export function parseKeys(many: string | undefined, single: string | undefined): string[] {
  const all = [...(many ?? '').split(/[\s,]+/), (single ?? '').trim()].map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)].slice(0, MAX_KEYS);
}

export class KeyError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) { super(message); this.status = status; }
}

export type Kind = 'dead' | 'limited' | 'transient' | 'fatal';
/** What a failed call says about the key. `fatal` means the request itself is wrong, so another key will not help. */
export function classify(status: number | null): Kind {
  if (status === null || status === 408 || status >= 500) return 'transient';   // timeout, network, server trouble
  if (status === 401 || status === 402 || status === 403) return 'dead';        // bad, revoked or unpaid key
  if (status === 429) return 'limited';                                           // quota or rate limit
  return 'fatal';
}
export const COOLDOWN_MS: Record<Exclude<Kind, 'fatal'>, number> = { dead: 10 * 60_000, limited: 60_000, transient: 15_000 };

export class KeyPool {
  keys: string[];
  coolUntil: number[];
  now: () => number;
  random: () => number;
  constructor(keys: string[], now = () => Date.now(), random = Math.random) {
    this.keys = keys; this.coolUntil = keys.map(() => 0); this.now = now; this.random = random;
  }
  /** Indexes to try, in order: ready keys starting at a random one (spreads the load), then cooling keys, soonest first. */
  order(): number[] {
    const t = this.now();
    const ready = this.keys.map((_, i) => i).filter((i) => this.coolUntil[i] <= t);
    const start = ready.length ? Math.floor(this.random() * ready.length) : 0;
    const rotated = [...ready.slice(start), ...ready.slice(0, start)];
    const cooling = this.keys.map((_, i) => i).filter((i) => this.coolUntil[i] > t).sort((a, b) => this.coolUntil[a] - this.coolUntil[b]);
    return [...rotated, ...cooling];
  }
  mark(index: number, kind: Exclude<Kind, 'fatal'>) { this.coolUntil[index] = this.now() + COOLDOWN_MS[kind]; }
}

export class AllKeysFailed extends Error {
  failures: string[];
  constructor(failures: string[]) { super(`All keys failed: ${failures.join('; ')}`); this.failures = failures; }
}

/** Run `call` with keys from the pool until one works, trying at most `maxAttempts` keys. Position (1-based) is for logs only; never log keys. */
export async function withKeys<T>(
  pool: KeyPool, maxAttempts: number, call: (key: string, position: number) => Promise<T>,
): Promise<{ value: T; position: number; failures: string[] }> {
  const failures: string[] = [];
  for (const index of pool.order().slice(0, maxAttempts)) {
    try {
      return { value: await call(pool.keys[index], index + 1), position: index + 1, failures };
    } catch (error) {
      const status = error instanceof KeyError ? error.status : null;
      const kind = error instanceof KeyError ? classify(status) : 'fatal';
      if (kind === 'fatal') throw error;
      pool.mark(index, kind);
      failures.push(`key ${index + 1}: ${status ?? 'no response'}`);
    }
  }
  throw new AllKeysFailed(failures);
}
