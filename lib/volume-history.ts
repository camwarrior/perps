import seedFile from "../data/defillama-volume-history.json";

import { type ChartPoint } from "@/lib/chart-series";

export const DAY_MS = 24 * 60 * 60 * 1000;

export type VolumeVenue = "risex" | "txflow";

type SeedPoint = { date: string; ts: number; volumeUsd: number };

type SeedFile = {
  venues: Record<VolumeVenue, { points: SeedPoint[] }>;
};

const seed = seedFile as SeedFile;

/** One UTC day's notional, summed across markets. `byDay` keys are UTC midnights. */
export type DayPull = {
  byDay: Map<number, number>;
  failed: number;
  total: number;
  error: string | null;
};

export type VolumeResolution = {
  points: ChartPoint[];
  note: string;
  extras: string[];
  /** Closed days are stored and the open day came back from every market. */
  settled: boolean;
};

export function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function seedPoints(venue: VolumeVenue): ChartPoint[] {
  return seed.venues[venue].points.map((point) => ({ t: point.ts, v: point.volumeUsd }));
}

export function lastSeedDate(points: ChartPoint[]): string | null {
  if (points.length === 0) return null;
  let last = points[0] as ChartPoint;
  for (const point of points) {
    if (point.t > last.t) last = point;
  }
  return new Date(last.t).toISOString().slice(0, 10);
}

export function volumeNote(through: string | null): string {
  const closed = through
    ? `Hasta el ${through}, el valor es el de DefiLlama y no se vuelve a calcular. Los días cerrados posteriores se calculan de nuevo con todos los mercados y quedan guardados.`
    : "Los días UTC cerrados se calculan con todos los mercados y quedan guardados.";
  return `Notional USDC de cada día UTC. ${closed} El día en curso suma volumen base × cierre y puede ir incompleto.`;
}

/** Sum candle notionals into UTC days inside [fromMs, toMs). Bars outside the window are dropped. */
export function bucketBars(bars: ChartPoint[], fromMs: number, toMs: number): Map<number, number> {
  const totals = new Map<number, number>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.t) || !Number.isFinite(bar.v)) continue;
    const day = utcDayStart(bar.t);
    if (day < fromMs || day >= toMs) continue;
    totals.set(day, (totals.get(day) ?? 0) + bar.v);
  }
  return totals;
}

/** A pull can be stored. An empty book or any missed market is not a close. */
export function pullComplete(pull: DayPull): boolean {
  return pull.error == null && pull.total > 0 && pull.failed === 0;
}

/** Enough markets answered to draw a bar, with a partial note when some did not. */
function pullUsable(pull: DayPull): boolean {
  return pull.error == null && pull.total > 0 && pull.failed < pull.total;
}

export function pullNote(pulls: DayPull[]): string | null {
  const problems = pulls.filter((pull) => !pullComplete(pull));
  if (problems.length === 0) return null;
  const counted = problems.filter((pull) => pull.failed > 0 && pull.total > 0);
  if (counted.length > 0) {
    const worst = counted.reduce((best, pull) => (pull.failed / pull.total > best.failed / best.total ? pull : best));
    return `Serie parcial: faltan ${worst.failed} de ${worst.total} mercados.`;
  }
  const message = problems.find((pull) => pull.error)?.error;
  if (message) return `El cálculo en vivo no respondió (${message}).`;
  return "El cálculo en vivo no respondió (sin mercados).";
}

type DayRange = { from: number; to: number; days: number[] };

/** Contiguous closed days share one candle request. `to` is the exclusive end. */
export function contiguousRanges(days: number[]): DayRange[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => a - b);
  const ranges: DayRange[] = [];
  let current: DayRange = { from: sorted[0] as number, to: (sorted[0] as number) + DAY_MS, days: [sorted[0] as number] };
  for (const day of sorted.slice(1)) {
    if (day === current.to) {
      current.to = day + DAY_MS;
      current.days.push(day);
    } else {
      ranges.push(current);
      current = { from: day, to: day + DAY_MS, days: [day] };
    }
  }
  ranges.push(current);
  return ranges;
}

function seedDayMap(points: ChartPoint[]): Map<number, ChartPoint> {
  const days = new Map<number, ChartPoint>();
  for (const point of points) days.set(utcDayStart(point.t), point);
  return days;
}

/**
 * Closed UTC days after the seed and before today.
 * The seed's own days are never in this list, so they are never refetched.
 */
export function closedDaysAfterSeed(seed: ChartPoint[], now: number): number[] {
  let last = -1;
  for (const point of seed) last = Math.max(last, utcDayStart(point.t));
  const today = utcDayStart(now);
  if (last < 0 || last >= today) return [];
  const days: number[] = [];
  for (let day = last + DAY_MS; day < today; day += DAY_MS) days.push(day);
  return days;
}

/**
 * Seed days stay as published. Missing closed days are fetched once, after they have
 * ended, and stored only when every market answered. The open UTC day is never stored.
 */
export async function resolveVenueVolume(options: {
  seed: ChartPoint[];
  now: number;
  readFrozen: (dayStartMs: number) => Promise<number | null>;
  writeFrozen: (entries: { dayStartMs: number; volume: number }[]) => Promise<boolean>;
  pull: (fromMs: number, toMs: number) => Promise<DayPull>;
}): Promise<VolumeResolution> {
  const today = utcDayStart(options.now);
  const published = seedDayMap(options.seed);
  const missing: number[] = [];
  const stored = new Map<number, number>();
  for (const day of closedDaysAfterSeed(options.seed, options.now)) {
    const value = await options.readFrozen(day);
    if (value == null) missing.push(day);
    else stored.set(day, value);
  }

  const pulls: DayPull[] = [];
  const fresh = new Map<number, number>();
  let todayValue: number | null = null;
  let todayFetched = false;
  let settled = true;
  const toStore: { dayStartMs: number; volume: number }[] = [];

  const take = async (fromMs: number, toMs: number): Promise<DayPull> => {
    try {
      return await options.pull(fromMs, toMs);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "error de red";
      return { byDay: new Map(), failed: 0, total: 0, error: message };
    }
  };

  for (const range of contiguousRanges(missing)) {
    // A range that ends at today's midnight can include the open day in the same candle call.
    const extend = range.to === today;
    const pull = await take(range.from, extend ? today + DAY_MS : range.to);
    pulls.push(pull);
    if (extend) {
      todayFetched = true;
      if (pullUsable(pull)) todayValue = pull.byDay.get(today) ?? 0;
    }
    if (!pullComplete(pull)) {
      settled = false;
      if (pullUsable(pull)) {
        for (const day of range.days) fresh.set(day, pull.byDay.get(day) ?? 0);
      }
      continue;
    }
    for (const day of range.days) {
      if (day >= today) continue;
      const volume = pull.byDay.get(day) ?? 0;
      fresh.set(day, volume);
      toStore.push({ dayStartMs: day, volume });
    }
  }

  if (!todayFetched) {
    const pull = await take(today, today + DAY_MS);
    pulls.push(pull);
    if (pullUsable(pull)) todayValue = pull.byDay.get(today) ?? 0;
    if (!pullComplete(pull)) settled = false;
  }

  if (toStore.length > 0) {
    const wrote = await options.writeFrozen(toStore);
    if (!wrote) settled = false;
  }

  const points: ChartPoint[] = [...options.seed]
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .map((point) => ({ t: point.t, v: point.v }));
  const seen = new Set(points.map((point) => utcDayStart(point.t)));
  for (const [day, volume] of [...stored, ...fresh]) {
    if (seen.has(day) || day >= today) continue;
    seen.add(day);
    points.push({ t: day, v: volume });
  }
  if (todayValue != null && !published.has(today)) {
    points.push({ t: today, v: todayValue });
  }
  points.sort((a, b) => a.t - b.t);

  const extra = pullNote(pulls);
  return {
    points,
    note: volumeNote(lastSeedDate(options.seed)),
    extras: extra ? [extra] : [],
    settled,
  };
}
