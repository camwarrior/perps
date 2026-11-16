export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type IntervalLimiter = {
  /** Wait until the next paced slot, then reserve the one after it. */
  take: () => Promise<void>;
  /** Push the next slot out by at least `ms`, so a 429 does not keep the same pace. */
  pause: (ms: number) => Promise<void>;
};

/**
 * Spaces call starts so a fan-out cannot exceed `minIntervalMs` between requests.
 * Concurrent callers share one queue.
 */
export function createIntervalLimiter(minIntervalMs: number, clock: Clock = realClock): IntervalLimiter {
  let nextAt = 0;
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void> | void): Promise<void> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    take: () =>
      enqueue(async () => {
        const wait = Math.max(0, nextAt - clock.now());
        nextAt = Math.max(clock.now(), nextAt) + minIntervalMs;
        if (wait > 0) await clock.sleep(wait);
      }),
    pause: (ms: number) =>
      enqueue(() => {
        nextAt = Math.max(nextAt, clock.now()) + Math.max(0, ms);
      }),
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 * After `deadlineMs`, no new item starts. In-flight calls finish. Unstarted slots stay `undefined`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { deadlineMs?: number },
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = Array.from({ length: items.length }, () => undefined);
  if (items.length === 0 || limit <= 0) return results;
  let cursor = 0;
  const started = Date.now();
  const deadline = options?.deadlineMs ?? Number.POSITIVE_INFINITY;
  const workers = Math.min(Math.floor(limit), items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        if (Date.now() - started >= deadline) return;
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index] as T, index);
      }
    }),
  );
  return results;
}
