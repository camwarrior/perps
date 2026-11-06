import "server-only";

import {
  notionalFromBase,
  rangeStart,
  slicePoints,
  sumBars,
  timestampToMs,
  toTwoSidedOi,
  volumeWeekStart,
  type ChartPoint,
  type ChartRange,
  type ChartSeries,
  type ChartsPayload,
} from "@/lib/chart-series";
import { fetchJson } from "@/lib/http";
import { asArray, asRecord, asString, parseNumber, publicError } from "@/lib/number";
import { loadMeta } from "@/lib/txflow";

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
 * Daily candles change once a day, so each venue's whole history is fetched once, cached,
 * and every range is a slice of it. Switching 1S → 1M → 1A costs no new upstream calls.
 */
const HISTORY_START_MS = Date.UTC(2025, 0, 1);
const HISTORY_TTL_MS = 10 * 60 * 1000;
/** A partial or failed pull is retried after this, instead of sitting in the cache for ten minutes. */
const RETRY_TTL_MS = 45 * 1000;

/** `at` is when the data was obtained; `checkedAt` is the last pull attempt. */
type History = { at: number; checkedAt: number; points: ChartPoint[]; failed: number; total: number; error: string | null };

const histories = new Map<"risex" | "txflow", History>();
const historyJobs = new Map<"risex" | "txflow", Promise<History>>();

function complete(history: History | undefined): boolean {
  return history != null && history.failed === 0 && history.error == null && history.points.length > 0;
}

/**
 * Pull a venue's history, deduplicating concurrent requests. A failed or partial pull does not
 * replace an earlier complete history: that one keeps being served, labeled with its age,
 * and the pull is retried after RETRY_TTL_MS.
 */
async function loadHistory(venue: "risex" | "txflow", pull: () => Promise<History>): Promise<History> {
  const now = Date.now();
  const cached = histories.get(venue);
  if (cached && now - cached.checkedAt < (complete(cached) ? HISTORY_TTL_MS : RETRY_TTL_MS)) return cached;
  const running = historyJobs.get(venue);
  if (running) return running;
  const job = pull()
    .catch((error: unknown): History => {
      const at = Date.now();
      return { at, checkedAt: at, points: [], failed: 0, total: 0, error: publicError(error) };
    })
    .then((next) => {
      const previous = histories.get(venue);
      if (!complete(next) && previous && complete(previous)) {
        const kept: History = {
          ...previous,
          checkedAt: next.checkedAt,
          error: next.error ?? `faltaron ${next.failed} de ${next.total} mercados`,
        };
        histories.set(venue, kept);
        return kept;
      }
      histories.set(venue, next);
      return next;
    })
    .finally(() => historyJobs.delete(venue));
  historyJobs.set(venue, job);
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

async function pullRiseHistory(): Promise<History> {
  const ids = await riseMarketIds();
  const endMs = Date.now();
  const bars = await mapPool(ids, 4, async (id) => {
    try {
      const payload = await fetchJson(
        `${RISE_MARKETS.replace(/\/markets$/, "")}/markets/id/${id}/trading-view-data?interval=${DAY_NS}&from=${HISTORY_START_MS}000000&to=${endMs}000000`,
        { timeoutMs: 12_000, retries: 2 },
      );
      return readRiseBars(payload);
    } catch {
      return null;
    }
  });
  const failed = bars.filter((item) => item == null).length;
  const points = sumBars(bars.filter((item): item is ChartPoint[] => item != null).flat());
  const at = Date.now();
  return { at, checkedAt: at, points, failed, total: ids.length, error: null };
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

async function pullTxHistory(): Promise<History> {
  // Same cached perpMeta as the live book, so the charts do not spend Txflow's rate limit on it.
  const coins = (await loadMeta()).filter((item) => !item.delisted && !item.halt).map((item) => item.base);
  const endMs = Date.now();
  // Txflow answers 429 to bursts: three at a time, each retried with backoff.
  const bars = await mapPool(coins, 3, async (coin) => {
    try {
      const payload = await fetchJson(TX_INFO, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-version": "2026-08-16" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: { coin, interval: "1d", startTime: HISTORY_START_MS, endTime: endMs },
        }),
        timeoutMs: 12_000,
        retries: 3,
      });
      return readTxBars(payload);
    } catch {
      return null;
    }
  });
  const failed = bars.filter((item) => item == null).length;
  const points = sumBars(bars.filter((item): item is ChartPoint[] => item != null).flat());
  const at = Date.now();
  return { at, checkedAt: at, points, failed, total: coins.length, error: null };
}

function ageLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function volumeSeries(
  venue: "RISEx" | "Txflow",
  history: History,
  range: ChartRange,
  now: number,
  source: string,
  note: string,
): ChartSeries {
  const startMs = range === "1S" ? volumeWeekStart(now) : rangeStart(range, now);
  const points = slicePoints(history.points, startMs);
  if (points.length === 0) {
    const why = history.error ? `${venue} no respondió (${history.error}).` : `${venue} no trajo velas en esta ventana.`;
    return emptySeries(source, why, "USDC");
  }
  const extra: string[] = [];
  if (history.error) extra.push(`Serie de hace ${ageLabel(now - history.at)}: el último intento falló (${history.error}).`);
  else if (history.failed > 0) extra.push(`Serie parcial: faltan ${history.failed} de ${history.total} mercados.`);
  return okSeries(points, "USDC", source, [note, ...extra].join(" "));
}

async function riseVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "GET /v1/markets/id/{id}/trading-view-data";
  const note = "Notional USDC estimado: volumen base × cierre, sumado entre mercados. Cada barra es un día UTC. La última puede ir incompleta.";
  return volumeSeries("RISEx", await loadHistory("risex", pullRiseHistory), range, now, source, note);
}

async function txVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "POST /info candleSnapshot";
  const note = "Notional USDC estimado: volumen base × cierre, sumado entre perpetuos. Cada barra es un día UTC. La última puede ir incompleta.";
  return volumeSeries("Txflow", await loadHistory("txflow", pullTxHistory), range, now, source, note);
}

let llamaJob: Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> | null = null;

/** Both OI series read the same DefiLlama payload: one request, shared. */
async function llamaOi(): Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> {
  if (llamaCache && Date.now() - llamaCache.at < CACHE_MS) return llamaCache.points;
  if (llamaJob) return llamaJob;
  llamaJob = pullLlama().finally(() => {
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
