import type { Market, QuoteOverride, VenueBook, VenueTotals } from "@/lib/types";

export type SortKey =
  | "base"
  | "last"
  | "mark"
  | "index"
  | "changeAbs"
  | "changePct"
  | "high"
  | "low"
  | "volumeUsdc"
  | "oiBase"
  | "oiUsdc"
  | "fundingPct"
  | "funding8hPct";

export type SortDir = "asc" | "desc";

export function emptyTotals(): VenueTotals {
  return {
    volume24hUsdc: null,
    openInterestUsdc: null,
    activeMarkets: 0,
    listedMarkets: 0,
  };
}

export function summarize(markets: Market[]): VenueTotals {
  let volume = 0;
  let volumeCount = 0;
  let openInterest = 0;
  let openInterestCount = 0;
  for (const market of markets) {
    if (market.volumeUsdc != null) {
      volume += market.volumeUsdc;
      volumeCount += 1;
    }
    if (market.oiUsdc != null) {
      openInterest += market.oiUsdc;
      openInterestCount += 1;
    }
  }
  return {
    volume24hUsdc: volumeCount > 0 ? volume : null,
    openInterestUsdc: openInterestCount > 0 ? openInterest : null,
    activeMarkets: markets.length,
    listedMarkets: markets.length,
  };
}

export function coverage(markets: Market[]): { oi: number; volume: number } {
  let oi = 0;
  let volume = 0;
  for (const market of markets) {
    if (market.oiUsdc != null) oi += 1;
    if (market.volumeUsdc != null) volume += 1;
  }
  return { oi, volume };
}

/** Recompute notional OI and 24h change from the inputs actually present. */
export function derive(market: Market): Market {
  const next: Market = { ...market };
  next.oiUsdc = next.mark != null && next.oiBase != null ? next.mark * next.oiBase : null;
  if (next.last != null && next.prevDayPx != null && next.prevDayPx !== 0) {
    next.changeAbs = next.last - next.prevDayPx;
    next.changePct = (next.changeAbs / next.prevDayPx) * 100;
  }
  return next;
}

export function withOverride(market: Market, override: QuoteOverride | undefined, receivedAt: number): Market {
  if (!override || override.at < receivedAt) return market;
  const next: Market = { ...market };
  if (override.last !== undefined) next.last = override.last;
  if (override.mark !== undefined) next.mark = override.mark;
  if (override.index !== undefined) next.index = override.index;
  if (override.oiBase !== undefined) next.oiBase = override.oiBase;
  if (override.fundingPct !== undefined) next.fundingPct = override.fundingPct;
  if (override.fundingInterval !== undefined) next.fundingInterval = override.fundingInterval;
  if (override.prevDayPx !== undefined) next.prevDayPx = override.prevDayPx;
  if (override.volumeUsdc !== undefined) next.volumeUsdc = override.volumeUsdc;
  if (override.high !== undefined) next.high = override.high;
  if (override.low !== undefined) next.low = override.low;
  return derive(next);
}

export function fillGaps(market: Market, override: QuoteOverride | undefined): Market {
  if (!override) return market;
  const next: Market = { ...market };
  let changed = false;
  const fill = (
    key: "last" | "mark" | "index" | "oiBase" | "fundingPct" | "prevDayPx" | "volumeUsdc" | "high" | "low",
    value: number | undefined,
  ) => {
    if (next[key] == null && value != null) {
      next[key] = value;
      changed = true;
    }
  };
  fill("last", override.last);
  fill("mark", override.mark);
  fill("index", override.index);
  fill("oiBase", override.oiBase);
  fill("fundingPct", override.fundingPct);
  fill("prevDayPx", override.prevDayPx);
  fill("volumeUsdc", override.volumeUsdc);
  fill("high", override.high);
  fill("low", override.low);
  if (next.fundingInterval == null && override.fundingInterval) {
    next.fundingInterval = override.fundingInterval;
    changed = true;
  }
  return changed ? derive(next) : market;
}

export function applyLive(market: Market, ws: QuoteOverride | undefined, gap: QuoteOverride | undefined, receivedAt: number): Market {
  return withOverride(fillGaps(market, gap), ws, receivedAt);
}

export type DecorateCache = Map<
  string,
  { base: Market; ws: QuoteOverride | undefined; gap: QuoteOverride | undefined; at: number; result: Market }
>;

/**
 * Merge live quotes into the polled book. With a cache, a market whose inputs did not change
 * keeps its previous object, so memoized rows skip re-rendering.
 */
export function decorateBook(
  book: VenueBook,
  ws: Record<string, QuoteOverride>,
  gaps: Record<string, QuoteOverride>,
  receivedAt: number,
  cache?: DecorateCache,
): VenueBook {
  if (!book.ok) return book;
  const markets = book.markets.map((market) => {
    const key = `${market.venue}:${market.id}`;
    const live = ws[key];
    const gap = gaps[key];
    const hit = cache?.get(key);
    if (hit && hit.base === market && hit.ws === live && hit.gap === gap && hit.at === receivedAt) return hit.result;
    const result = applyLive(market, live, gap, receivedAt);
    cache?.set(key, { base: market, ws: live, gap, at: receivedAt, result });
    return result;
  });
  return { ...book, markets, totals: summarize(markets) };
}

export function filterMarkets(markets: Market[], query: string): Market[] {
  const needle = query.trim().toUpperCase();
  if (!needle) return markets;
  return markets.filter(
    (market) => market.base.includes(needle) || market.symbol.toUpperCase().includes(needle),
  );
}

export function sortMarkets(markets: Market[], key: SortKey, dir: SortDir): Market[] {
  const sign = dir === "asc" ? 1 : -1;
  return markets.toSorted((left, right) => compareValues(left[key], right[key], sign, left.symbol, right.symbol));
}

function compareValues(
  left: number | string | null,
  right: number | string | null,
  sign: number,
  leftSymbol: string,
  rightSymbol: string,
): number {
  const leftMissing = left == null || left === "";
  const rightMissing = right == null || right === "";
  if (leftMissing && rightMissing) return leftSymbol.localeCompare(rightSymbol);
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (typeof left === "string" && typeof right === "string") {
    const cmp = left.localeCompare(right);
    return cmp === 0 ? leftSymbol.localeCompare(rightSymbol) : cmp * sign;
  }
  if (typeof left === "number" && typeof right === "number") {
    const cmp = left - right;
    return cmp === 0 ? leftSymbol.localeCompare(rightSymbol) : cmp * sign;
  }
  return 0;
}

export type CompareRow = {
  base: string;
  risex: Market | null;
  txflow: Market | null;
};

function byBase(markets: Market[]): Map<string, Market> {
  const map = new Map<string, Market>();
  for (const market of markets) {
    const prev = map.get(market.base);
    if (!prev || (market.volumeUsdc ?? -1) > (prev.volumeUsdc ?? -1)) map.set(market.base, market);
  }
  return map;
}

export function compareRows(risex: Market[], txflow: Market[]): CompareRow[] {
  const left = byBase(risex);
  const right = byBase(txflow);
  const rows: CompareRow[] = [];
  for (const [base, market] of left) {
    const other = right.get(base);
    if (!other) continue;
    rows.push({ base, risex: market, txflow: other });
  }
  return rows;
}

/** Txflow last versus RISEx last, in percent of the RISEx price. */
export function lastSpreadPct(risex: number | null, txflow: number | null): number | null {
  if (risex == null || txflow == null || risex === 0) return null;
  return ((txflow - risex) / risex) * 100;
}

export type CompareSortKey =
  | "base"
  | "volume"
  | "rxLast"
  | "rxPct"
  | "rxVol"
  | "rxOi"
  | "rxFund"
  | "txLast"
  | "txPct"
  | "txVol"
  | "txOi"
  | "txFund"
  | "spread";

function compareValue(row: CompareRow, key: CompareSortKey): number | string | null {
  switch (key) {
    case "base":
      return row.base;
    case "volume": {
      const values = [row.risex?.volumeUsdc, row.txflow?.volumeUsdc].filter((value): value is number => value != null);
      return values.length ? Math.max(...values) : null;
    }
    case "rxLast":
      return row.risex?.last ?? null;
    case "rxPct":
      return row.risex?.changePct ?? null;
    case "rxVol":
      return row.risex?.volumeUsdc ?? null;
    case "rxOi":
      return row.risex?.oiUsdc ?? null;
    case "rxFund":
      return row.risex?.fundingPct ?? null;
    case "txLast":
      return row.txflow?.last ?? null;
    case "txPct":
      return row.txflow?.changePct ?? null;
    case "txVol":
      return row.txflow?.volumeUsdc ?? null;
    case "txOi":
      return row.txflow?.oiUsdc ?? null;
    case "txFund":
      return row.txflow?.fundingPct ?? null;
    case "spread":
      return lastSpreadPct(row.risex?.last ?? null, row.txflow?.last ?? null);
    default:
      return null;
  }
}

export function sortCompare(rows: CompareRow[], key: CompareSortKey, dir: SortDir): CompareRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows.toSorted((left, right) =>
    compareValues(compareValue(left, key), compareValue(right, key), sign, left.base, right.base),
  );
}

export function filterCompare(rows: CompareRow[], query: string): CompareRow[] {
  const needle = query.trim().toUpperCase();
  if (!needle) return rows;
  return rows.filter((row) => row.base.includes(needle));
}

/** Hours in a funding interval label such as "1h", "1.5h" or "30m". */
export function intervalHours(label: string | null): number | null {
  if (!label) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(h|m)$/i.exec(label.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2].toLowerCase() === "m" ? amount / 60 : amount;
}

/** Interval funding carried to a year, simple (not compounded), in percent. */
export function fundingAprPct(fundingPct: number | null, interval: string | null): number | null {
  const hours = intervalHours(interval);
  if (fundingPct == null || hours == null) return null;
  return fundingPct * (8760 / hours);
}

/** Share of the first value in the sum of both, in percent. Null unless both are present. */
export function sharePct(left: number | null, right: number | null): number | null {
  if (left == null || right == null || left < 0 || right < 0 || left + right === 0) return null;
  return (left / (left + right)) * 100;
}
