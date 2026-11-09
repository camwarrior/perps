import assert from "node:assert/strict";
import test from "node:test";

import {
  chartResponseCache,
  HISTORY_START_MS,
  historyComplete,
  historyStart,
  notionalFromBase,
  pickTxflowCoins,
  rangeStart,
  settleHistory,
  slicePoints,
  sumBars,
  timestampToMs,
  toTwoSidedOi,
  TXFLOW_CANDLE_CAP,
  volumeWeekStart,
  type CandleHistory,
  type ChartsPayload,
  type ChartSeries,
} from "./chart-series";

test("range windows and timestamp scale", () => {
  const now = Date.parse("2026-11-06T00:00:00.000Z");
  assert.equal(rangeStart("1S", now), now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(rangeStart("1A", now), now - 365 * 24 * 60 * 60 * 1000);
  assert.equal(rangeStart("ALL", now), null);
  assert.equal(volumeWeekStart(Date.parse("2026-11-06T06:00:00.000Z")), Date.parse("2026-10-31T00:00:00.000Z"));
  assert.equal(timestampToMs("1793836800000000000"), 1793836800000);
  assert.equal(timestampToMs("1793836800000"), 1793836800000);
});

test("DefiLlama OI points scale to the two-sided convention", () => {
  assert.deepEqual(toTwoSidedOi([{ t: 1793923200000, v: 39206537 }]), [{ t: 1793923200000, v: 78413074 }]);
  assert.deepEqual(toTwoSidedOi([{ t: 1, v: 0 }]), [{ t: 1, v: 0 }]);
});

test("notional uses base times close and skips a zero close with volume", () => {
  assert.equal(notionalFromBase(893.746241, 75968.4), 893.746241 * 75968.4);
  assert.equal(notionalFromBase(10, 0), null);
  assert.equal(notionalFromBase(0, 100), 0);
});

test("1S requests one UTC week and longer ranges stay lazy", () => {
  const now = Date.parse("2026-11-06T06:00:00.000Z");
  assert.equal(historyStart("1S", now), volumeWeekStart(now));
  assert.ok(historyStart("1S", now) > HISTORY_START_MS);
  assert.equal(historyStart("ALL", now), HISTORY_START_MS);
  const month = historyStart("1M", now);
  assert.ok(month <= rangeStart("1M", now)!);
  assert.equal(month, Date.parse("2026-10-07T00:00:00.000Z"));
});

function history(partial: Partial<CandleHistory> & Pick<CandleHistory, "fromMs" | "points" | "failed" | "error">): CandleHistory {
  return {
    at: 1,
    checkedAt: 1,
    total: 4,
    staleError: null,
    scopeNote: null,
    ...partial,
  };
}

test("a failed pull does not replace a clean history, including a second failure", () => {
  const clean = history({ fromMs: 100, points: [{ t: 100, v: 5 }], failed: 0, error: null });
  assert.equal(historyComplete(clean), true);
  const first = settleHistory(clean, history({ fromMs: 100, points: [], failed: 2, total: 4, error: null, checkedAt: 50 }));
  assert.equal(first.stored.points[0]?.v, 5);
  assert.match(first.stored.staleError ?? "", /faltaron 2 de 4/);
  assert.equal(historyComplete(first.stored), true);
  const second = settleHistory(first.stored, history({ fromMs: 100, points: [], failed: 4, total: 4, error: "429", checkedAt: 80 }));
  assert.equal(second.served.points[0]?.v, 5);
  assert.equal(second.stored.error, null);
  assert.match(second.stored.staleError ?? "", /429/);
});

test("a short clean refresh keeps the longer history and updates the overlap", () => {
  const month = history({
    fromMs: 1,
    points: [
      { t: 1, v: 1 },
      { t: 10, v: 2 },
    ],
    failed: 0,
    error: null,
  });
  const week = history({ fromMs: 10, points: [{ t: 10, v: 9 }], failed: 0, error: null, at: 2, checkedAt: 2 });
  const settled = settleHistory(month, week);
  assert.deepEqual(settled.served.points, [
    { t: 1, v: 1 },
    { t: 10, v: 9 },
  ]);
  assert.equal(settled.stored.fromMs, 1);
});

test("a deeper failure is served as itself and the shorter clean history stays stored", () => {
  const week = history({ fromMs: 100, points: [{ t: 100, v: 5 }], failed: 0, error: null });
  const month = history({ fromMs: 10, points: [{ t: 10, v: 1 }], failed: 1, total: 4, error: null, checkedAt: 9 });
  const settled = settleHistory(week, month);
  assert.equal(settled.stored, week);
  assert.equal(settled.served.points[0]?.t, 10);
});

test("Txflow candles cover 99.5 % of 24 h volume and never the whole book", () => {
  const meta = Array.from({ length: 241 }, (_, index) => ({ index, base: `C${index}` }));
  assert.deepEqual(pickTxflowCoins(meta, null), { coins: [], capped: false, coverage: null, traded: 0 });
  const rows = [
    { instrumentId: 0, volume: 0 },
    { instrumentId: 1, volume: 900 },
    { instrumentId: 2, volume: 96 },
    { instrumentId: 3, volume: 3 },
    { instrumentId: 4, volume: 1 },
  ];
  const picked = pickTxflowCoins(meta, rows);
  // 900 + 96 = 99.6 % of 1,000: the 0.4 % tail is left out.
  assert.deepEqual(picked.coins, ["C1", "C2"]);
  assert.equal(picked.capped, true);
  assert.ok((picked.coverage ?? 0) >= 0.995);
  assert.equal(picked.traded, 4);
  // Flat volume: the hard cap stops it before every listed perp.
  const flat = Array.from({ length: 241 }, (_, index) => ({ instrumentId: index, volume: 1 }));
  const capped = pickTxflowCoins(meta, flat);
  assert.equal(capped.coins.length, TXFLOW_CANDLE_CAP);
  assert.equal(capped.capped, true);
  assert.equal(capped.coins[0], "C0");
});

function pointSeries(ok: boolean, note: string): ChartSeries {
  return { ok, error: ok ? null : note, unit: "USDC", source: "test", note, points: ok ? [{ t: 1, v: 1 }] : [] };
}

function payload(notes: [string, string, string, string], oks: [boolean, boolean, boolean, boolean] = [true, true, true, true]): ChartsPayload {
  return {
    range: "1S",
    generatedAt: 1,
    venues: {
      risex: { volume: pointSeries(oks[0], notes[0]), oi: pointSeries(oks[1], notes[1]) },
      txflow: { volume: pointSeries(oks[2], notes[2]), oi: pointSeries(oks[3], notes[3]) },
    },
  };
}

test("a handful of missing markets stays CDN-cacheable and a down venue does not", () => {
  const warm = chartResponseCache(payload(["", "", "Serie parcial: faltan 6 de 40 mercados.", ""]));
  assert.match(warm.browser, /max-age=60/);
  assert.match(warm.cdn, /s-maxage=300/);
  const stale = chartResponseCache(payload(["", "", "Serie de hace 3 min: el último intento falló (429).", ""]));
  assert.match(stale.cdn, /s-maxage=300/);
  const cold = chartResponseCache(payload(["", "", "Serie parcial: faltan 20 de 40 mercados.", ""]));
  assert.match(cold.browser, /max-age=0/);
  assert.match(cold.cdn, /s-maxage=20/);
  const down = chartResponseCache(payload(["", "", "Txflow no respondió.", ""], [true, true, false, true]));
  assert.match(down.cdn, /s-maxage=20/);
  const liveDown = chartResponseCache(payload(["", "", "El cálculo en vivo no respondió (timeout).", ""]));
  assert.match(liveDown.cdn, /s-maxage=20/);
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
