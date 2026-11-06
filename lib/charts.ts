import "server-only";

import { cacheLife } from "next/cache";

import {
  historyComplete,
  historyStart,
  notionalFromBase,
  rangeStart,
  settleHistory,
  slicePoints,
  sumBars,
  timestampToMs,
  toTwoSidedOi,
  volumeWeekStart,
  type CandleHistory,
  type ChartPoint,
  type ChartRange,
  type ChartSeries,
  type ChartsPayload,
} from "@/lib/chart-series";
import { fetchJson } from "@/lib/http";
import { asArray, asRecord, asString, parseNumber, publicError } from "@/lib/number";
import { tradedCoins } from "@/lib/txflow";

const RISE_MARKETS = "https://api.rise.trade/v1/markets";
const TX_INFO = "https://rpc.txflow.com/info";
const LLAMA_OI = "https://api.llama.fi/overview/open-interest";
const CACHE_MS = 10 * 60 * 1000;
const DAY_NS = "86400000000000";
/** The assembled payload per range; the expensive part, the histories, has its own cache. */
const RANGE_TTL_MS = 30 * 1000;

const cache = new Map<ChartRange, { at: number; data: ChartsPayload }>();
const inflight = new Map<ChartRange, Promise<ChartsPayload>>();

let llamaCache: { at: number; points: { risex: ChartPoint[]; txflow: ChartPoint[] } } | null = null;

function emptySeries(source: string, note: string, unit = ""): ChartSeries {
  return { ok: false, error: note, unit, source, note, points: [] };
}

function okSeries(points: ChartPoint[], unit: string, source: string, note: string): ChartSeries {
  return { ok: true, error: null, unit, source, note, points };
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

/**
 * Daily candles change once a day. 1S fetches about one UTC week; 1M, 3M, 1A and ALL
 * widen that window the first time someone asks. Each market's bars are cached on their
 * own, so a later isolate reuses the markets that already succeeded and a failed market
 * does not wipe a good candle.
 */
const HISTORY_TTL_MS = 10 * 60 * 1000;
/** A partial or failed pull is retried after this, instead of sitting in the cache for ten minutes. */
const RETRY_TTL_MS = 45 * 1000;
/** Shared candle cache: fresh for five minutes, reusable for a day, same for every isolate. */
const CANDLE_LIFE = { stale: 60, revalidate: 300, expire: 86_400 } as const;

const histories = new Map<"risex" | "txflow", CandleHistory>();
const historyJobs = new Map<string, Promise<CandleHistory>>();

function historyTtl(history: CandleHistory): number {
  if (history.staleError) return RETRY_TTL_MS;
  return historyComplete(history) ? HISTORY_TTL_MS : RETRY_TTL_MS;
}

/**
 * Pull the window a range needs, deduplicating concurrent requests for that window.
 * A failed or partial pull does not replace an earlier clean history. The clean one keeps
 * being served for windows it covers, with a note, and the pull is retried after RETRY_TTL_MS.
 */
async function loadHistory(venue: "risex" | "txflow", fromMs: number, pull: (fromMs: number) => Promise<CandleHistory>): Promise<CandleHistory> {
  const now = Date.now();
  const cached = histories.get(venue);
  if (cached && cached.fromMs <= fromMs && now - cached.checkedAt < historyTtl(cached)) return cached;
  const key = `${venue}:${fromMs}`;
  const running = historyJobs.get(key);
  if (running) return running;
  const job = pull(fromMs)
    .catch((error: unknown): CandleHistory => {
      const at = Date.now();
      return { at, checkedAt: at, fromMs, points: [], failed: 0, total: 0, error: publicError(error), staleError: null, scopeNote: null };
    })
    .then((next) => {
      const settled = settleHistory(histories.get(venue), next);
      histories.set(venue, settled.stored);
      return settled.served;
    })
    .finally(() => historyJobs.delete(key));
  historyJobs.set(key, job);
  return job;
}

async function riseMarketIds(): Promise<string[]> {
  const payload = await fetchJson(RISE_MARKETS, { timeoutMs: 12_000, retries: 2 });
  const rows = asArray(asRecord(asRecord(payload)?.data)?.markets);
  if (!rows) throw new Error("sin mercados");
  const ids: string[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item || item.active !== true) continue;
    const id = asString(item.market_id) ?? (typeof item.market_id === "number" ? String(item.market_id) : null);
    if (id) ids.push(id);
  }
  return ids;
}

function readRiseBars(payload: unknown): ChartPoint[] {
  const root = asRecord(payload);
  const data = root?.data;
  const rows = asArray(data) ?? asArray(asRecord(data)?.data);
  if (!rows) return [];
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

/** One market's daily bars. A thrown fetch is not stored, so a later 429 cannot replace a good candle. */
async function cachedRiseBars(id: string, fromMs: number): Promise<ChartPoint[]> {
  "use cache: remote";
  cacheLife(CANDLE_LIFE);
  const endMs = Date.now();
  const payload = await fetchJson(
    `${RISE_MARKETS.replace(/\/markets$/, "")}/markets/id/${id}/trading-view-data?interval=${DAY_NS}&from=${fromMs}000000&to=${endMs}000000`,
    { timeoutMs: 12_000, retries: 2 },
  );
  return readRiseBars(payload);
}

async function pullRiseHistory(fromMs: number): Promise<CandleHistory> {
  const ids = await riseMarketIds();
  const bars = await mapPool(ids, 4, async (id) => {
    try {
      return await cachedRiseBars(id, fromMs);
    } catch {
      return null;
    }
  });
  const failed = bars.filter((item) => item == null).length;
  const points = sumBars(bars.filter((item): item is ChartPoint[] => item != null).flat());
  const at = Date.now();
  const error = points.length === 0 && failed > 0 ? `faltaron ${failed} de ${ids.length} mercados` : null;
  return { at, checkedAt: at, fromMs, points, failed, total: ids.length, error, staleError: null, scopeNote: null };
}

function readTxBars(payload: unknown): ChartPoint[] {
  const rows = asArray(asRecord(payload)?.data);
  if (!rows) return [];
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

/** One perp's daily bars. Same rule as RISEx: a failed snapshot is not written over a cached one. */
async function cachedTxBars(coin: string, fromMs: number): Promise<ChartPoint[]> {
  "use cache: remote";
  cacheLife(CANDLE_LIFE);
  const payload = await fetchJson(TX_INFO, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-version": "2026-08-16" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval: "1d", startTime: fromMs, endTime: Date.now() },
    }),
    timeoutMs: 12_000,
    retries: 3,
  });
  return readTxBars(payload);
}

async function pullTxHistory(fromMs: number): Promise<CandleHistory> {
  // Only perps that traded in the last 24 h. No webData2 means no candle calls, not the whole book.
  const selection = await tradedCoins();
  const at = Date.now();
  if (selection.unavailable) {
    return {
      at,
      checkedAt: at,
      fromMs,
      points: [],
      failed: 0,
      total: 0,
      error: "webData2 no respondió",
      staleError: null,
      scopeNote: null,
    };
  }
  const coins = selection.coins;
  // One decimal, floored, so 99.96 % reads 99,9 % and never rounds up to a full 100 %.
  const pct = selection.coverage == null ? null : (Math.floor(selection.coverage * 1000) / 10).toFixed(1).replace(".", ",");
  const scopeNote = selection.capped
    ? `Suma de los ${coins.length} de ${selection.traded} perpetuos con volumen en 24 h, que son el ${pct ?? "—"} % de ese notional; el resto es marginal.`
    : coins.length > 0
      ? `Son los ${coins.length} perpetuos con volumen en 24 h.`
      : null;
  if (coins.length === 0) {
    return { at, checkedAt: at, fromMs, points: [], failed: 0, total: 0, error: null, staleError: null, scopeNote };
  }
  // Txflow answers 429 to bursts: three at a time, each retried with Retry-After.
  const bars = await mapPool(coins, 3, async (coin) => {
    try {
      return await cachedTxBars(coin, fromMs);
    } catch {
      return null;
    }
  });
  const failed = bars.filter((item) => item == null).length;
  const points = sumBars(bars.filter((item): item is ChartPoint[] => item != null).flat());
  const done = Date.now();
  const error = points.length === 0 && failed > 0 ? `faltaron ${failed} de ${coins.length} mercados` : null;
  return { at: done, checkedAt: done, fromMs, points, failed, total: coins.length, error, staleError: null, scopeNote };
}

function ageLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function volumeSeries(
  venue: "RISEx" | "Txflow",
  history: CandleHistory,
  range: ChartRange,
  now: number,
  source: string,
  note: string,
): ChartSeries {
  const startMs = range === "1S" ? volumeWeekStart(now) : rangeStart(range, now);
  if (startMs != null && history.fromMs > startMs) {
    const why = history.error ? `${venue} no respondió (${history.error}).` : `${venue} no trajo velas en esta ventana.`;
    return emptySeries(source, why, "USDC");
  }
  const points = slicePoints(history.points, startMs);
  if (points.length === 0) {
    const why = history.error ? `${venue} no respondió (${history.error}).` : `${venue} no trajo velas en esta ventana.`;
    return emptySeries(source, why, "USDC");
  }
  const extra: string[] = [];
  if (history.scopeNote) extra.push(history.scopeNote);
  if (history.staleError) extra.push(`Serie de hace ${ageLabel(now - history.at)}: el último intento falló (${history.staleError}).`);
  else if (history.error) extra.push(`Serie de hace ${ageLabel(now - history.at)}: el último intento falló (${history.error}).`);
  else if (history.failed > 0) extra.push(`Serie parcial: faltan ${history.failed} de ${history.total} mercados.`);
  return okSeries(points, "USDC", source, [note, ...extra].filter(Boolean).join(" "));
}

async function riseVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "GET /v1/markets/id/{id}/trading-view-data";
  const note = "Notional USDC estimado: volumen base × cierre, sumado entre mercados. Cada barra es un día UTC. La última puede ir incompleta.";
  return volumeSeries("RISEx", await loadHistory("risex", historyStart(range, now), pullRiseHistory), range, now, source, note);
}

async function txVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "POST /info candleSnapshot";
  const note = "Notional USDC estimado: volumen base × cierre, sumado entre los perpetuos con volumen en 24 h. Cada barra es un día UTC. La última puede ir incompleta.";
  return volumeSeries("Txflow", await loadHistory("txflow", historyStart(range, now), pullTxHistory), range, now, source, note);
}

let llamaJob: Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> | null = null;

/** Both OI series read the same DefiLlama payload: one request, shared across isolates. */
async function cachedLlamaOi(): Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> {
  "use cache: remote";
  cacheLife({ stale: 60, revalidate: 600, expire: 86_400 });
  return pullLlama();
}

async function llamaOi(): Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> {
  if (llamaCache && Date.now() - llamaCache.at < CACHE_MS) return llamaCache.points;
  if (llamaJob) return llamaJob;
  const previous = llamaCache;
  llamaJob = cachedLlamaOi()
    .then((points) => {
      llamaCache = { at: Date.now(), points };
      return points;
    })
    .catch((error: unknown) => {
      if (previous) return previous.points;
      throw error;
    })
    .finally(() => {
      llamaJob = null;
    });
  return llamaJob;
}

async function pullLlama(): Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> {
  const payload = await fetchJson(LLAMA_OI, { timeoutMs: 20_000 });
  const rows = asArray(asRecord(payload)?.totalDataChartBreakdown);
  const risex: ChartPoint[] = [];
  const txflow: ChartPoint[] = [];
  for (const row of rows ?? []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const seconds = typeof row[0] === "number" ? row[0] : parseNumber(row[0]);
    const book = asRecord(row[1]);
    if (seconds == null || !book) continue;
    const t = seconds * 1000;
    const rise = parseNumber(book.RISEx);
    const tx = parseNumber(book["TxFlow Perps"]);
    if (rise != null) risex.push({ t, v: rise });
    if (tx != null) txflow.push({ t, v: tx });
  }
  const points = { risex: toTwoSidedOi(risex), txflow: toTwoSidedOi(txflow) };
  llamaCache = { at: Date.now(), points };
  return points;
}

async function oiSeries(name: "risex" | "txflow", range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "DefiLlama · overview/open-interest";
  const note = "Notional USD a dos lados (largo + corto), igual que el tablero y Dune. DefiLlama publica la mitad; esta serie es ese cierre diario UTC ×2, no el OI en vivo.";
  try {
    const all = await llamaOi();
    const points = slicePoints(name === "risex" ? all.risex : all.txflow, rangeStart(range, now));
    if (points.length === 0) {
      return emptySeries(source, "DefiLlama no tiene puntos de OI en esta ventana.", "USD");
    }
    return okSeries(points, "USD", source, note);
  } catch (error) {
    return emptySeries(source, `DefiLlama no respondió (${publicError(error)}).`, "USD");
  }
}

export async function getCharts(range: ChartRange, now = Date.now()): Promise<ChartsPayload> {
  const hit = cache.get(range);
  if (hit && now - hit.at < RANGE_TTL_MS) return hit.data;
  const pending = inflight.get(range);
  if (pending) return pending;
  const job = Promise.all([riseVolume(range, now), oiSeries("risex", range, now), txVolume(range, now), oiSeries("txflow", range, now)])
    .then(([riseVol, riseOi, txVol, txOi]) => {
      const data: ChartsPayload = {
        range,
        generatedAt: Date.now(),
        venues: {
          risex: { volume: riseVol, oi: riseOi },
          txflow: { volume: txVol, oi: txOi },
        },
      };
      cache.set(range, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflight.delete(range);
    });
  inflight.set(range, job);
  return job;
}
