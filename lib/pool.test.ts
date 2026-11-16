import assert from "node:assert/strict";
import test from "node:test";

import { createIntervalLimiter, mapPool, type Clock } from "./pool";

test("interval limiter reserves slots one interval apart", async () => {
  let now = 1_000;
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  const limiter = createIntervalLimiter(50, clock);
  const stamps: number[] = [];
  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      await limiter.take();
      stamps.push(now);
    }),
  );
  assert.deepEqual(stamps, [1_000, 1_050, 1_100, 1_150]);

  await limiter.pause(200);
  await limiter.take();
  assert.equal(now, 1_400);
});

test("mapPool caps in-flight work and does not start past the deadline", async () => {
  let active = 0;
  let max = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = mapPool([1, 2, 3, 4], 2, async () => {
    active += 1;
    max = Math.max(max, active);
    await gate;
    active -= 1;
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(active, 2);
  assert.equal(max, 2);
  release();
  const done = await running;
  assert.equal(done.filter(Boolean).length, 4);
  assert.equal(active, 0);

  let calls = 0;
  const skipped = await mapPool([1, 2, 3], 2, async (item) => {
    calls += 1;
    return item;
  }, { deadlineMs: 0 });
  assert.equal(calls, 0);
  assert.deepEqual(skipped, [undefined, undefined, undefined]);
});

test("mapPool keeps successful rows when a callback returns null", async () => {
  const results = await mapPool([1, 2, 3], 2, async (item) => (item === 2 ? null : item * 10));
  assert.deepEqual(results, [10, null, 30]);
});

test("mapPool rejects when a callback throws", async () => {
  await assert.rejects(
    mapPool([1, 2], 1, async (item) => {
      if (item === 2) throw new Error("ticker");
      return item;
    }),
    /ticker/,
  );
});
