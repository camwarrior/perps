import { derive } from "@/lib/market";
import {
  asArray,
  asInt,
  asRecord,
  asString,
  baseFromSymbol,
  intervalLabelFromMs,
  parseNumber,
} from "@/lib/number";
import type { Market } from "@/lib/types";

export type MetaInstrument = {
  index: number;
  name: string;
  base: string;
  delisted: boolean;
  halt: boolean;
};

export type WebRow = {
  instrumentId: number;
  coin: string;
  last: number | null;
  high: number | null;
  low: number | null;
  prev: number | null;
  volume: number | null;
  volumeBase: number | null;
};

export type CtxRow = {
  mark: number | null;
  index: number | null;
  last: number | null;
  oi: number | null;
  funding: number | null;
  nextFunding: number | null;
  prevFunding: number | null;
};

export type TickerRow = {
  id: number;
  last: number | null;
  mark: number | null;
  index: number | null;
  oi: number | null;
  funding: number | null;
  interval: string | null;
  prev: number | null;
  volume: number | null;
  changeAbs: number | null;
  changePct: number | null;
};

function requireSuccess(payload: unknown, label: string): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root || root.success === false) {
    throw new Error(asString(root?.message) ?? `${label} rechazado`);
  }
  const data = asRecord(root.data);
  if (!data) throw new Error(`${label} sin data`);
  return data;
}

export function parsePerpMeta(payload: unknown): MetaInstrument[] {
  const data = requireSuccess(payload, "perpMeta");
  const universe = asArray(data.universe);
  if (!universe) throw new Error("perpMeta sin universo");
  const instruments: MetaInstrument[] = [];
  for (const item of universe) {
    const row = asRecord(item);
    if (!row) continue;
    const index = asInt(row.index);
    const name = asString(row.name);
    const base = asString(row.baseCurrency);
    if (index == null || !name || !base) continue;
    instruments.push({
      index,
      name,
      base: base.toUpperCase(),
      delisted: row.delisted === true,
      halt: row.haltTrading === true,
    });
  }
  return instruments;
}

export function parseWebData(payload: unknown): WebRow[] {
  const data = requireSuccess(payload, "webData2");
  const rows = asArray(data.assetCtxs);
  if (!rows) throw new Error("webData2 sin assetCtxs");
  const parsed: WebRow[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    if (!row) continue;
    const instrumentId = asInt(row.instrumentId);
    const coin = asString(row.coin);
    if (instrumentId == null || !coin) continue;
    parsed.push({
      instrumentId,
      coin,
      last: parseNumber(row.lastPrice),
      high: parseNumber(row.dayHighPx),
      low: parseNumber(row.dayLowPx),
      prev: parseNumber(row.prevDayPx),
      volume: parseNumber(row.dayNtlVlm),
      volumeBase: parseNumber(row.coinVlm),
    });
  }
  return parsed;
}

export function parseAssetCtxs(rows: unknown): Map<number, CtxRow> {
  const list = asArray(rows);
  const map = new Map<number, CtxRow>();
  if (!list) return map;
  for (const item of list) {
    const row = asRecord(item);
    const ctx = asRecord(row?.ctx);
    const id = asInt(row?.coin);
    if (!ctx || id == null) continue;
    map.set(id, {
      mark: parseNumber(ctx.markPx),
      index: parseNumber(ctx.oraclePx),
      last: parseNumber(ctx.lastPrice),
      oi: parseNumber(ctx.openInterest),
      funding: parseNumber(ctx.funding),
      nextFunding: parseNumber(ctx.nextFundingTime),
      prevFunding: parseNumber(ctx.prevFundingTime),
    });
  }
  return map;
}

export function parseMarketTicker(payload: unknown, id: number): TickerRow {
  const data = requireSuccess(payload, "marketTicker");
  const intervalMs = parseNumber(data.settlementIntervalMs);
  return {
    id,
    last: parseNumber(data.lastPrice),
    mark: parseNumber(data.markPx),
    index: parseNumber(data.oraclePx),
    oi: parseNumber(data.openInterest),
    funding: parseNumber(data.fundingRate),
    interval: intervalLabelFromMs(intervalMs),
    prev: parseNumber(data.prevDayPx),
    volume: parseNumber(data.dayNtlVlm),
    changeAbs: parseNumber(data.change24h),
    changePct: parseNumber(data.change24hPct),
  };
}

function intervalFromCtx(ctx: CtxRow | undefined): string | null {
  if (!ctx || ctx.nextFunding == null || ctx.prevFunding == null) return null;
  return intervalLabelFromMs(ctx.nextFunding - ctx.prevFunding);
}

function blankMarket(partial: Pick<Market, "id" | "symbol" | "base"> & Partial<Market>): Market {
  return derive({
    venue: "txflow",
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
  });
}

export function assembleTxflow(input: {
  meta: MetaInstrument[] | null;
  web: WebRow[] | null;
  ctxs: Map<number, CtxRow> | null;
  tickers: Map<number, TickerRow> | null;
}): { markets: Market[]; omitted: number } {
  const webById = new Map((input.web ?? []).map((row) => [row.instrumentId, row]));
  const markets: Market[] = [];
  let omitted = 0;

  const push = (id: number, symbol: string, base: string) => {
    const web = webById.get(id);
    const ctx = input.ctxs?.get(id);
    const ticker = input.tickers?.get(id);
    const last = ctx?.last ?? web?.last ?? ticker?.last ?? null;
    const prev = web?.prev ?? ticker?.prev ?? null;
    const mark = ctx?.mark ?? ticker?.mark ?? null;
    const index = ctx?.index ?? ticker?.index ?? null;
    const oiBase = ctx?.oi ?? ticker?.oi ?? null;
    const fundingPct = ctx?.funding ?? ticker?.funding ?? null;
    const fundingInterval = intervalFromCtx(ctx) ?? ticker?.interval ?? null;
    const volumeUsdc = web?.volume ?? ticker?.volume ?? null;
    let changeAbs: number | null = null;
    let changePct: number | null = null;
    if (!(last != null && prev != null && prev !== 0)) {
      changeAbs = ticker?.changeAbs ?? null;
      changePct = ticker?.changePct ?? null;
    }
    markets.push(
      blankMarket({
        id: String(id),
        symbol,
        base,
        last,
        mark,
        index,
        high: web?.high ?? null,
        low: web?.low ?? null,
        volumeUsdc,
        volumeBase: web?.volumeBase ?? null,
        oiBase,
        fundingPct,
        fundingInterval,
        prevDayPx: prev,
        changeAbs,
        changePct,
      }),
    );
  };

  if (input.meta) {
    for (const instrument of input.meta) {
      if (instrument.delisted || instrument.halt) {
        omitted += 1;
        continue;
      }
      push(instrument.index, instrument.name, instrument.base);
    }
    return { markets, omitted };
  }

  for (const row of input.web ?? []) {
    if (row.instrumentId >= 10_000) continue;
    const symbol = row.coin.includes("/") || row.coin.includes("-") ? row.coin : `${row.coin}-USDC`;
    push(row.instrumentId, symbol, baseFromSymbol(symbol));
  }
  return { markets, omitted };
}

