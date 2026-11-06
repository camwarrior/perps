import assert from "node:assert/strict";
import test from "node:test";

import { notionalFromBase, rangeStart, slicePoints, sumBars, timestampToMs, volumeWeekStart } from "./chart-series";

test("range windows and timestamp scale", () => {
  const now = Date.parse("2026-11-06T00:00:00.000Z");
  assert.equal(rangeStart("1S", now), now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(rangeStart("1A", now), now - 365 * 24 * 60 * 60 * 1000);
  assert.equal(rangeStart("ALL", now), null);
  assert.equal(volumeWeekStart(Date.parse("2026-11-06T06:00:00.000Z")), Date.parse("2026-10-31T00:00:00.000Z"));
  assert.equal(timestampToMs("1793836800000000000"), 1793836800000);
  assert.equal(timestampToMs("1793836800000"), 1793836800000);
});

test("notional uses base times close and skips a zero close with volume", () => {
  assert.equal(notionalFromBase(893.746241, 75968.4), 893.746241 * 75968.4);
  assert.equal(notionalFromBase(10, 0), null);
  assert.equal(notionalFromBase(0, 100), 0);
});

test("bars sum by timestamp and do not fill missing days", () => {
  const points = sumBars([
    { t: 2, v: 5 },
    { t: 1, v: 3 },
    { t: 2, v: 4 },
  ]);
  assert.deepEqual(points, [
    { t: 1, v: 3 },
    { t: 2, v: 9 },
  ]);
  const sliced = slicePoints(
    [
      { t: 10, v: 1 },
      { t: 30, v: 2 },
    ],
    20,
  );
  assert.deepEqual(sliced, [{ t: 30, v: 2 }]);
});
