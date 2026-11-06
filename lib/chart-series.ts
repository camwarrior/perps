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
