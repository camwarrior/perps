import "server-only";

import { getCache, type RuntimeCache } from "@vercel/functions";

import { notionalFromBase, timestampToMs, type ChartPoint } from "@/lib/chart-series";
import { fetchJson } from "@/lib/http";
import { asArray, asRecord, asString, parseNumber, publicError } from "@/lib/number";
import { loadMeta } from "@/lib/txflow";
import {
  bucketBars,
  pullComplete,
  resolveVenueVolume,
  seedPoints,
  utcDayStart,
  type DayPull,
  type VolumeResolution,
  type VolumeVenue,
} from "@/lib/volume-history";

const RISE_MARKETS = "https://api.rise.trade/v1/markets";
const TX_INFO = "https://rpc.txflow.com/info";
const DAY_NS = "86400000000000";
const TX_VERSION = "2026-08-16";
/** One year. Each new close rewrites the blob and refreshes this. */
const FROZEN_TTL_SECONDS = 60 * 60 * 24 * 365;
const LIVE_PULL_MS = 60_000;
const SETTLED_MS = 30_000;
const UNSETTLED_MS = 5_000;

export const RISE_VOLUME_SOURCE = "DefiLlama protocol/perps/risex · GET trading-view-data";
export const TX_VOLUME_SOURCE = "DefiLlama protocol/perps/txflow-perps · POST candleSnapshot";

const memoryBlobs = new Map<VolumeVenue, Record<string, number>>();
const livePulls = new Map<string, { at: number; data: DayPull }>();
const pullJobs = new Map<string, Promise<DayPull>>();
const built = new Map<string, { at: number; data: VolumeResolution }>();
const builtJobs = new Map<string, Promise<VolumeResolution>>();

function remoteCache(): RuntimeCache | null {
  // Runtime Cache is injected on Vercel and keeps closed days across deployments.
  // Off Vercel the process map is enough, and a miss recomputes that day.
  if (process.env.VERCEL !== "1" && !process.env.RUNTIME_CACHE_ENDPOINT) return null;
  try {
    return getCache({ namespace: "camwarrior-perps-volume-v1" });
  } catch {
    return null;
  }
}

function parseBlob(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const days: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!/^\d+$/.test(key) || typeof item !== "number" || !Number.isFinite(item)) continue;
    days[key] = item;
  }
  return days;
}

async function readFrozenMap(venue: VolumeVenue): Promise<Record<string, number>> {
  const local = memoryBlobs.get(venue) ?? {};
  const cache = remoteCache();
  if (!cache) return { ...local };
  try {
    const stored = parseBlob(await cache.get(venue));
    const merged = { ...stored, ...local };
    memoryBlobs.set(venue, merged);
    return merged;
  } catch {
    return { ...local };
  }
}

async function writeFrozenDays(
  venue: VolumeVenue,
  todayStartMs: number,
  entries: { dayStartMs: number; volume: number }[],
): Promise<boolean> {
  const additions = entries.filter((entry) => entry.dayStartMs < todayStartMs && Number.isFinite(entry.volume));
  if (additions.length === 0) return true;
  const cache = remoteCache();
  if (!cache) {
    const current = { ...(memoryBlobs.get(venue) ?? {}) };
    for (const entry of additions) {
      const key = String(entry.dayStartMs);
      if (current[key] == null) current[key] = entry.volume;
    }
    memoryBlobs.set(venue, current);
    return true;
  }
  try {
    const current = parseBlob(await cache.get(venue));
    let changed = false;
    for (const entry of additions) {
      const key = String(entry.dayStartMs);
      if (current[key] == null) {
        current[key] = entry.volume;
        changed = true;
      }
    }
    if (changed) {
      await cache.set(venue, current, { ttl: FROZEN_TTL_SECONDS, name: `volume-${venue}` });
    }
    memoryBlobs.set(venue, { ...current, ...(memoryBlobs.get(venue) ?? {}) });
    return true;
  } catch {
    return false;
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function riseMarketIds(): Promise<string[]> {
  const payload = await fetchJson(RISE_MARKETS, { timeoutMs: 12_000, retries: 2 });
  const rows = asArray(asRecord(asRecord(payload)?.data)?.markets);
  if (!rows) throw new Error("sin mercados");
  const ids: string[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const id = asString(item.market_id) ?? (typeof item.market_id === "number" ? String(item.market_id) : null);
    if (id) ids.push(id);
  }
  return ids;
}

function readRiseBars(payload: unknown): ChartPoint[] {
  const root = asRecord(payload);
  const data = root?.data;
  const rows = asArray(data) ?? asArray(asRecord(data)?.data);
  if (!rows) throw new Error("trading-view-data sin velas");
  const bars: ChartPoint[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const time = asString(item.time) ?? (typeof item.time === "number" ? String(item.time) : null);
    const t = time ? timestampToMs(time) : null;
    const notional = notionalFromBase(parseNumber(item.volume), parseNumber(item.close));
    if (t == null || notional == null) continue;
    bars.push({ t, v: notional });
  }
  return bars;
}

async function fetchRiseBars(id: string, fromMs: number, toMs: number): Promise<ChartPoint[]> {
  const payload = await fetchJson(
    `${RISE_MARKETS}/id/${id}/trading-view-data?interval=${DAY_NS}&from=${fromMs}000000&to=${toMs}000000`,
    { timeoutMs: 12_000, retries: 2 },
  );
  return readRiseBars(payload);
}

function readTxBars(payload: unknown): ChartPoint[] {
  const root = asRecord(payload);
  if (!root || root.success === false) throw new Error(asString(root?.message) ?? "candleSnapshot rechazado");
  const rows = asArray(root.data);
  if (!rows) throw new Error("candleSnapshot sin data");
  const bars: ChartPoint[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const t = typeof item.t === "number" ? item.t : parseNumber(item.t);
    const notional = notionalFromBase(parseNumber(item.v), parseNumber(item.c));
    if (t == null || notional == null) continue;
    bars.push({ t, v: notional });
  }
  return bars;
}

async function fetchTxBars(coin: string, fromMs: number, toMs: number): Promise<ChartPoint[]> {
  const payload = await fetchJson(TX_INFO, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-version": TX_VERSION },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval: "1d", startTime: fromMs, endTime: toMs },
    }),
    timeoutMs: 12_000,
    retries: 3,
  });
  return readTxBars(payload);
}

async function txBases(): Promise<string[]> {
  const meta = await loadMeta();
  const bases = new Set<string>();
  for (const item of meta) {
    if (!item.delisted && item.base) bases.add(item.base);
  }
  return [...bases].sort((a, b) => a.localeCompare(b));
}

async function pullMarkets(
  ids: string[],
  limit: number,
  fromMs: number,
  toMs: number,
  fetchBars: (id: string) => Promise<ChartPoint[]>,
): Promise<DayPull> {
  const totals = new Map<number, number>();
  const bars = await mapPool(ids, limit, async (id) => {
    try {
      return await fetchBars(id);
    } catch {
      return null;
    }
  });
  let failed = 0;
  for (const item of bars) {
    if (item == null) {
      failed += 1;
      continue;
    }
    for (const [day, volume] of bucketBars(item, fromMs, toMs)) {
      totals.set(day, (totals.get(day) ?? 0) + volume);
    }
  }
  return { byDay: totals, failed, total: ids.length, error: null };
}

function dedupedPull(key: string, fromMs: number, run: () => Promise<DayPull>): Promise<DayPull> {
  const openDay = utcDayStart(Date.now());
  const cached = livePulls.get(key);
  // Only the open day is reused, and only for a minute. A closed-day fetch is always fresh.
  if (cached && fromMs >= openDay && Date.now() - cached.at < LIVE_PULL_MS && pullComplete(cached.data)) {
    return Promise.resolve(cached.data);
  }
  const pending = pullJobs.get(key);
  if (pending) return pending;
  const job = run()
    .then((data) => {
      if (fromMs >= utcDayStart(Date.now()) && pullComplete(data)) livePulls.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => pullJobs.delete(key));
  pullJobs.set(key, job);
  return job;
}

function pullRisex(fromMs: number, toMs: number): Promise<DayPull> {
  return dedupedPull(`risex:${fromMs}:${toMs}`, fromMs, async () => {
    let ids: string[];
    try {
      ids = await riseMarketIds();
    } catch (error) {
      return { byDay: new Map(), failed: 0, total: 0, error: publicError(error) };
    }
    if (ids.length === 0) return { byDay: new Map(), failed: 0, total: 0, error: "sin mercados" };
    return pullMarkets(ids, 4, fromMs, toMs, (id) => fetchRiseBars(id, fromMs, toMs));
  });
}

function pullTxflow(fromMs: number, toMs: number): Promise<DayPull> {
  return dedupedPull(`txflow:${fromMs}:${toMs}`, fromMs, async () => {
    let bases: string[];
    try {
      bases = await txBases();
    } catch (error) {
      return { byDay: new Map(), failed: 0, total: 0, error: publicError(error) };
    }
    if (bases.length === 0) return { byDay: new Map(), failed: 0, total: 0, error: "sin mercados" };
    return pullMarkets(bases, 3, fromMs, toMs, (coin) => fetchTxBars(coin, fromMs, toMs));
  });
}

async function computeVenue(venue: VolumeVenue, now: number): Promise<VolumeResolution> {
  const today = utcDayStart(now);
  const frozen = await readFrozenMap(venue);
  return resolveVenueVolume({
    seed: seedPoints(venue),
    now,
    readFrozen: async (day) => {
      const value = frozen[String(day)];
      return typeof value === "number" ? value : null;
    },
    writeFrozen: (entries) => writeFrozenDays(venue, today, entries),
    pull: (from, to) => (venue === "risex" ? pullRisex(from, to) : pullTxflow(from, to)),
  });
}

export function getVenueVolume(venue: VolumeVenue, now = Date.now()): Promise<VolumeResolution> {
  const key = `${venue}:${utcDayStart(now)}`;
  const hit = built.get(key);
  if (hit && now - hit.at < (hit.data.settled ? SETTLED_MS : UNSETTLED_MS)) return Promise.resolve(hit.data);
  const pending = builtJobs.get(key);
  if (pending) return pending;
  const job = computeVenue(venue, now)
    .then((data) => {
      built.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => builtJobs.delete(key));
  builtJobs.set(key, job);
  return job;
}
