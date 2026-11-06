import assert from "node:assert/strict";
import test from "node:test";

import { parseRiseExposure7d, parseRiseVolume, volumeFromFills } from "./wallet-parse";
import { totalVolume } from "./wallet-types";
import { formatUtcWeek, msToNanos, utcWeek } from "./week";

test("UTC week starts Monday 00:00:00.000 and ends the next Monday", () => {
  const friday = Date.parse("2026-11-06T05:45:36.520Z");
  const week = utcWeek(friday);
  assert.equal(new Date(week.startMs).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(week.endMs).toISOString(), "2026-11-09T00:00:00.000Z");

  const monday = Date.parse("2026-11-02T00:00:00.000Z");
  assert.equal(utcWeek(monday).startMs, monday);

  const justBefore = Date.parse("2026-11-01T23:59:59.999Z");
  assert.equal(new Date(utcWeek(justBefore).startMs).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(msToNanos(week.startMs), "1793577600000000000");
  assert.match(formatUtcWeek(week.startMs, week.endMs), /UTC/);
  assert.match(formatUtcWeek(week.startMs, week.endMs), /sin incluir/);
});

test("RISEx total_volume is the week notional, including zero", () => {
  assert.equal(parseRiseVolume({ data: { total_volume: "60665722.239141" } }), 60665722.239141);
  assert.equal(parseRiseVolume({ data: { total_volume: "0" } }), 0);
  assert.throws(() => parseRiseVolume({ data: {} }));
});

test("RISEx 7d exposure uses only d7.market_exposure", () => {
  const payload = {
    data: {
      h24: { market_exposure: "1" },
      d7: { market_exposure: "23663.427849" },
      d30: { market_exposure: "9" },
      all_time: { market_exposure: "8" },
    },
  };
  assert.equal(parseRiseExposure7d(payload), 23663.427849);
  assert.equal(parseRiseExposure7d({ data: { d7: { market_exposure: "0" } } }), 0);
  assert.throws(() => parseRiseExposure7d({ data: { h24: { market_exposure: "1" } } }));
  assert.throws(() => parseRiseExposure7d({ data: { d7: { market_exposure: "" } } }));
});

test("Txflow volume sums fill notionals inside the window and drops a partial read", () => {
  const start = 1_000;
  const end = 2_000;
  const full = volumeFromFills(
    [
      {
        rows: [
          { px: 10, sz: 2, time: 1_000 },
          { px: 10, sz: -1, time: 1_999 },
          { px: 10, sz: 5, time: 2_000 },
        ],
        hasMore: false,
        total: 2,
      },
    ],
    start,
    end,
  );
  assert.equal(full.truncated, false);
  assert.equal(full.volumeUsdc, 30);

  const partial = volumeFromFills(
    [{ rows: [{ px: 10, sz: 1, time: 1_100 }], hasMore: true, total: 800_000 }],
    start,
    end,
  );
  assert.equal(partial.volumeUsdc, null);
  assert.equal(partial.truncated, true);
  assert.equal(totalVolume(10, 5), 15);
  assert.equal(totalVolume(10, null), null);
  assert.equal(totalVolume(null, 0), null);
});

test("short UTC week label names the seven days", async () => {
  const { formatUtcWeekShort } = await import("./week");
  const week = utcWeek(Date.UTC(2026, 10, 6, 12));
  assert.equal(formatUtcWeekShort(week.startMs, week.endMs), "Semana UTC 2–8 nov 2026");
});
