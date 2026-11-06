import assert from "node:assert/strict";
import test from "node:test";

import { formatCompact, formatFunding, formatPrice } from "./format";
import { derive, fillGaps, lastSpreadPct, sortMarkets, withOverride } from "./market";
import { baseFromSymbol, intervalLabelFromNanos, parseNumber, weiToNumber } from "./number";
import { parseRisex } from "./risex-parse";
import { assembleTxflow, parseAssetCtxs, parseMarketTicker, parsePerpMeta, parseWebData } from "./txflow-parse";
import type { Market } from "./types";

function market(partial: Partial<Market> & Pick<Market, "id" | "symbol" | "base" | "venue">): Market {
  return {
    active: true,
    last: null,
    mark: null,
    index: null,
    changeAbs: null,
    changePct: null,
    high: null,
    low: null,
    volumeUsdc: null,
    volumeBase: null,
    oiBase: null,
    oiUsdc: null,
    fundingPct: null,
    fundingInterval: null,
    funding8hPct: null,
    prevDayPx: null,
    ...partial,
  };
}

test("empty strings are missing, zeros are real", () => {
  assert.equal(parseNumber(""), null);
  assert.equal(parseNumber("  "), null);
  assert.equal(parseNumber("0"), 0);
  assert.equal(parseNumber(0), 0);
});

test("wei conversion keeps price past MAX_SAFE_INTEGER", () => {
  const price = weiToNumber("75574459046663920000000");
  assert.ok(price != null);
  assert.ok(Math.abs(price - 75574.45904666) < 1e-6);
});

test("RISEx change, funding and inactive filter", () => {
  const parsed = parseRisex({
    data: {
      cached_at: "1793938604",
      markets: [
        {
          market_id: "1",
          display_name: "BTC/USDC",
          active: true,
          quote_volume_24h: "68541659.85",
          change_24h: "-4761.7",
          high_24h: "80689.4",
          low_24h: "73796",
          last_price: "75598.6",
          mark_price: "75609.37",
          index_price: "75629.31",
          open_interest: "240.445352",
          current_funding_rate: "-0.000003313817536426",
          funding_rate_8h: "-0.000026510540291408",
          funding_interval: "3600000000000",
        },
        {
          market_id: "99",
          display_name: "DOGE/USDC [deprecated]",
          active: false,
          quote_volume_24h: "0",
          last_price: "0",
          mark_price: "0",
          open_interest: "0",
          change_24h: "0",
          current_funding_rate: "0",
          funding_rate_8h: "0",
          funding_interval: "3600000000000",
        },
      ],
    },
  });
  assert.equal(parsed.omitted, 1);
  assert.equal(parsed.markets.length, 1);
  const btc = parsed.markets[0]!;
  assert.equal(btc.base, "BTC");
  assert.equal(btc.fundingInterval, "1h");
  assert.ok(Math.abs((btc.changePct ?? 0) - (-4761.7 / (75598.6 + 4761.7)) * 100) < 1e-9);
  assert.ok(Math.abs((btc.fundingPct ?? 0) - -0.0003313817536426) < 1e-12);
  assert.ok(Math.abs((btc.funding8hPct ?? 0) - -0.0026510540291408) < 1e-12);
  assert.ok(Math.abs((btc.oiUsdc ?? 0) - 240.445352 * 75609.37) < 1e-4);
  assert.equal(intervalLabelFromNanos("3600000000000"), "1h");
});

test("Txflow keeps empty web OI empty and does not invent an 8h rate", () => {
  const meta = parsePerpMeta({
    success: true,
    code: 0,
    data: {
      universe: [
        { index: 1, name: "BTC-USDC", baseCurrency: "BTC", delisted: false, haltTrading: false },
        { index: 9, name: "OLD-USDC", baseCurrency: "OLD", delisted: true, haltTrading: false },
      ],
    },
  });
  const web = parseWebData({
    success: true,
    code: 0,
    data: {
      assetCtxs: [
        {
          coin: "BTC",
          instrumentId: 1,
          dayNtlVlm: "1000",
          coinVlm: "2",
          prevDayPx: "100",
          lastPrice: "110",
          dayHighPx: "120",
          dayLowPx: "90",
          openInterest: "",
          oraclePx: "",
          markPx: "",
        },
        { coin: "BTC/USDC", instrumentId: 10000, dayNtlVlm: "5", lastPrice: "1", prevDayPx: "1" },
      ],
    },
  });
  const withoutCtx = assembleTxflow({ meta, web, ctxs: null, tickers: null });
  assert.equal(withoutCtx.omitted, 1);
  assert.equal(withoutCtx.markets.length, 1);
  assert.equal(withoutCtx.markets[0]?.mark, null);
  assert.equal(withoutCtx.markets[0]?.oiBase, null);
  assert.equal(withoutCtx.markets[0]?.oiUsdc, null);
  assert.equal(withoutCtx.markets[0]?.funding8hPct, null);
  assert.equal(withoutCtx.markets[0]?.symbol, "BTC-USDC");

  const ctxs = parseAssetCtxs([
    {
      coin: "1",
      ctx: {
        funding: "0.00065809",
        openInterest: "328.2",
        oraclePx: "111",
        markPx: "110.5",
        lastPrice: "110.2",
        nextFundingTime: 3_600_000,
        prevFundingTime: 0,
      },
    },
  ]);
  const withCtx = assembleTxflow({ meta, web, ctxs, tickers: null });
  const btc = withCtx.markets[0]!;
  assert.equal(btc.mark, 110.5);
  assert.equal(btc.oiBase, 328.2);
  assert.ok(Math.abs((btc.oiUsdc ?? 0) - 328.2 * 110.5) < 1e-6);
  assert.equal(btc.fundingPct, 0.00065809);
  assert.equal(btc.fundingInterval, "1h");
  assert.equal(btc.funding8hPct, null);
  assert.equal(btc.last, 110.2);
  assert.equal(btc.volumeUsdc, 1000);
});

test("marketTicker funding is already percent and spot ids stay out of the fallback book", () => {
  const ticker = parseMarketTicker(
    {
      success: true,
      data: {
        instrumentId: 1,
        lastPrice: "10",
        markPx: "10.5",
        oraclePx: "10.4",
        openInterest: "2",
        fundingRate: "0.00125",
        settlementIntervalMs: 3_600_000,
        prevDayPx: "9",
        dayNtlVlm: "50",
        change24h: "1",
        change24hPct: "11.11",
      },
    },
    1,
  );
  assert.equal(ticker.funding, 0.00125);
  assert.equal(ticker.interval, "1h");
  const assembled = assembleTxflow({
    meta: null,
    web: [
      {
        instrumentId: 10000,
        coin: "BTC/USDC",
        last: 1,
        high: null,
        low: null,
        prev: 1,
        volume: 5,
        volumeBase: null,
      },
      {
        instrumentId: 13,
        coin: "SOL",
        last: 80,
        high: 90,
        low: 70,
        prev: 100,
        volume: 10,
        volumeBase: 1,
      },
    ],
    ctxs: null,
    tickers: new Map([[1, ticker]]),
  });
  assert.deepEqual(
    assembled.markets.map((item) => item.base),
    ["SOL"],
  );
});

test("gaps fill missing mark without erasing a newer last, and nulls sort last", () => {
  const base = derive(
    market({
      venue: "txflow",
      id: "1",
      symbol: "BTC-USDC",
      base: "BTC",
      last: 100,
      prevDayPx: 80,
      volumeUsdc: 10,
    }),
  );
  const filled = fillGaps(base, { at: 5, mark: 101, oiBase: 2, fundingPct: 0.01, fundingInterval: "1h" });
  assert.equal(filled.last, 100);
  assert.equal(filled.mark, 101);
  assert.equal(filled.oiUsdc, 202);
  assert.equal(filled.fundingInterval, "1h");

  const overwritten = withOverride(filled, { at: 20, last: 90 }, 10);
  assert.equal(overwritten.last, 90);
  assert.equal(overwritten.mark, 101);
  const stale = withOverride(filled, { at: 5, last: 1 }, 10);
  assert.equal(stale.last, 100);

  const rows = sortMarkets(
    [
      market({ venue: "risex", id: "a", symbol: "A", base: "A", volumeUsdc: null }),
      market({ venue: "risex", id: "b", symbol: "B", base: "B", volumeUsdc: 2 }),
      market({ venue: "risex", id: "c", symbol: "C", base: "C", volumeUsdc: 5 }),
    ],
    "volumeUsdc",
    "desc",
  );
  assert.deepEqual(
    rows.map((row) => row.base),
    ["C", "B", "A"],
  );
});

test("symbol base and compact USDC", () => {
  assert.equal(baseFromSymbol("BTC/USDC"), "BTC");
  assert.equal(baseFromSymbol("1000BONK-USDC"), "1000BONK");
  assert.equal(baseFromSymbol("DOGE/USDC [deprecated-1]"), "DOGE");
  assert.equal(formatCompact(68_541_659.85), "68.5M");
  assert.equal(formatCompact(170_132_827), "170.1M");
  assert.equal(formatCompact(1_250), "1.25K");
  assert.equal(formatFunding(-0.000331), "-0.000331%");
  assert.equal(formatFunding(0.00125), "+0.001250%");
  assert.equal(formatPrice(75598.6), "75,598.60");
  assert.equal(lastSpreadPct(100, 101), 1);
  assert.equal(lastSpreadPct(0, 1), null);
});
