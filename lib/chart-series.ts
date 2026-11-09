export const CHART_RANGES = ["1S", "1M", "3M", "1A", "ALL"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export type ChartPoint = { t: number; v: number };

export type ChartSeries = {
  ok: boolean;
  error: string | null;
  unit: string;
  source: string;
  note: string;
  points: ChartPoint[];
};

export type ChartsPayload = {
  range: ChartRange;
  generatedAt: number;
  venues: {
    risex: { volume: ChartSeries; oi: ChartSeries };
    txflow: { volume: ChartSeries; oi: ChartSeries };
  };
};

const DAY = 24 * 60 * 60 * 1000;

export function isChartRange(value: string): value is ChartRange {
  return (CHART_RANGES as readonly string[]).includes(value);
}

export function rangeStart(range: ChartRange, now: number): number | null {
  if (range === "1S") return now - 7 * DAY;
  if (range === "1M") return now - 30 * DAY;
  if (range === "3M") return now - 90 * DAY;
  if (range === "1A") return now - 365 * DAY;
  return null;
}

/** UTC midnight of the first of seven daily bars ending on today's UTC date. */
export function volumeWeekStart(now: number): number {
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return today - 6 * DAY;
}

/** DefiLlama stores venue OI single-sided. Boards and Dune publish long+short, exactly ×2. */
export function toTwoSidedOi(points: ChartPoint[]): ChartPoint[] {
  return points.map((point) => ({ t: point.t, v: point.v * 2 }));
}

export function slicePoints(points: ChartPoint[], startMs: number | null): ChartPoint[] {
  const sorted = points.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v)).toSorted((a, b) => a.t - b.t);
  if (startMs == null) return sorted;
  return sorted.filter((point) => point.t >= startMs);
}

/** Sum published bars that share a timestamp. Missing markets are not filled with zero. */
export function sumBars(bars: ChartPoint[]): ChartPoint[] {
  const totals = new Map<number, number>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.t) || !Number.isFinite(bar.v)) continue;
    totals.set(bar.t, (totals.get(bar.t) ?? 0) + bar.v);
  }
  return [...totals.entries()].toSorted((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

export function notionalFromBase(volume: number | null, close: number | null): number | null {
  if (volume == null || close == null) return null;
  if (close === 0 && volume !== 0) return null;
  return Math.abs(volume * close);
}

export function timestampToMs(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  const nanos = BigInt("1000000000000000");
  const scale = BigInt(1000000);
  const ms = value > nanos ? value / scale : value;
  const parsed = Number(ms);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** First UTC day we are willing to request. Longer windows are loaded only when a range needs them. */
export const HISTORY_START_MS = Date.UTC(2025, 0, 1);

/**
 * Candle window for a range, aligned so every visitor in the same UTC day shares a cache key.
 * 1S is one UTC week of daily bars, not the history since 2025.
 */
export function historyStart(range: ChartRange, now: number): number {
  if (range === "ALL") return HISTORY_START_MS;
  if (range === "1S") return volumeWeekStart(now);
  const start = rangeStart(range, now) ?? HISTORY_START_MS;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Old shortlist, kept for the selector tests. Volume charts do not use it: a single UTC day
 * is cheap enough to request every listed perp.
 * Txflow reports some 24 h volume on almost every listed perp, so "traded" alone means ~240
 * names. This stops at the given share of that notional.
 */
export const TXFLOW_COVERAGE = 0.995;
/** Hard stop for the old shortlist, in case the volume book is broken. */
export const TXFLOW_CANDLE_CAP = 200;

export type TxCoin = { index: number; base: string };
export type TxVolumeRow = { instrumentId: number; volume: number | null };

/**
 * Largest perps by 24 h notional, up to TXFLOW_COVERAGE. Not used by the volume charts.
 * `rows === null` means volume is unknown. That is an empty set, never the whole book.
 */
export function pickTxflowCoins(
  meta: TxCoin[],
  rows: TxVolumeRow[] | null,
): { coins: string[]; capped: boolean; coverage: number | null; traded: number } {
  if (!rows) return { coins: [], capped: false, coverage: null, traded: 0 };
  const volumeById = new Map<number, number>();
  for (const row of rows) {
    const volume = row.volume ?? 0;
    if (volume > 0) volumeById.set(row.instrumentId, volume);
  }
  const ranked = meta
    .map((item) => ({ base: item.base, volume: volumeById.get(item.index) ?? 0 }))
    .filter((item) => item.volume > 0)
    .toSorted((a, b) => b.volume - a.volume || a.base.localeCompare(b.base));
  if (ranked.length === 0) return { coins: [], capped: false, coverage: 0, traded: 0 };
  const total = ranked.reduce((sum, item) => sum + item.volume, 0);
  const kept: typeof ranked = [];
  let covered = 0;
  for (const item of ranked) {
    if (kept.length >= TXFLOW_CANDLE_CAP) break;
    kept.push(item);
    covered += item.volume;
    if (total > 0 && covered / total >= TXFLOW_COVERAGE) break;
  }
  return {
    coins: kept.map((item) => item.base),
    capped: kept.length < ranked.length,
    coverage: total > 0 ? covered / total : 0,
    traded: ranked.length,
  };
}

/** A venue history assembled from per-market daily candles. */
export type CandleHistory = {
  at: number;
  checkedAt: number;
  /** First timestamp requested. A later range can reuse this only when its start is at or after fromMs. */
  fromMs: number;
  points: ChartPoint[];
  failed: number;
  total: number;
  /** This pull itself failed. Distinct from staleError, which is a note on an older good pull. */
  error: string | null;
  /** Set when these points are an older clean pull and a later attempt did not replace them. */
  staleError: string | null;
  scopeNote: string | null;
};

/** A clean pull: every requested market returned and the call itself did not fail. */
export function historyComplete(history: CandleHistory | undefined): boolean {
  return history != null && history.failed === 0 && history.error == null && history.points.length > 0;
}

function mergeDeeper(deeper: CandleHistory, shallower: CandleHistory): CandleHistory {
  const kept = deeper.points.filter((point) => point.t < shallower.fromMs);
  return {
    ...deeper,
    at: shallower.at,
    checkedAt: shallower.checkedAt,
    points: [...kept, ...shallower.points].toSorted((a, b) => a.t - b.t),
    failed: 0,
    error: null,
    staleError: null,
  };
}

/**
 * A failed or partial pull must not replace a clean history, and a short refresh must not
 * drop a longer clean one. The value to serve can still be the new pull when the stored
 * history does not cover the window that was just requested.
 */
export function settleHistory(previous: CandleHistory | undefined, next: CandleHistory): { stored: CandleHistory; served: CandleHistory } {
  if (!historyComplete(next) && previous && historyComplete(previous)) {
    const failedThisDepth = next.fromMs >= previous.fromMs;
    const stored: CandleHistory = failedThisDepth
      ? {
          ...previous,
          checkedAt: next.checkedAt,
          staleError: next.error ?? `faltaron ${next.failed} de ${next.total} mercados`,
        }
      : previous;
    const served = previous.fromMs <= next.fromMs ? stored : next;
    return { stored, served };
  }
  if (historyComplete(next) && previous && historyComplete(previous) && previous.fromMs < next.fromMs) {
    const stored = mergeDeeper(previous, next);
    return { stored, served: stored };
  }
  return { stored: next, served: next };
}

/** Missing markets at or below this still count as a cacheable series. */
const HANDFUL = 10;

function missingMarkets(note: string): number | null {
  const match = /faltan (\d+) de \d+/.exec(note);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : null;
}

/**
 * True when every series has points and at most a handful of markets are missing.
 * A venue that did not answer at all stays on the short policy so the next request retries.
 */
export function chartsAreWarm(charts: ChartsPayload): boolean {
  const series = [charts.venues.risex.volume, charts.venues.risex.oi, charts.venues.txflow.volume, charts.venues.txflow.oi];
  return series.every((item) => {
    if (!item.ok || item.note.includes("no respondió")) return false;
    const missing = missingMarkets(item.note);
    return missing == null || missing <= HANDFUL;
  });
}

const LONG_BROWSER = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
const LONG_CDN = "public, max-age=300, s-maxage=300, stale-while-revalidate=86400";
const SHORT_BROWSER = "public, max-age=0, s-maxage=20, stale-while-revalidate=60";
const SHORT_CDN = "public, max-age=20, s-maxage=20, stale-while-revalidate=60";

/**
 * Browser and CDN policies. The CDN headers are repeated as CDN-Cache-Control and
 * Vercel-CDN-Cache-Control because a dynamic route (it reads the query string) can
 * have Cache-Control rewritten on the way out; those two headers are what the CDN honors.
 */
export function chartResponseCache(charts: ChartsPayload): { browser: string; cdn: string } {
  return chartsAreWarm(charts) ? { browser: LONG_BROWSER, cdn: LONG_CDN } : { browser: SHORT_BROWSER, cdn: SHORT_CDN };
}
