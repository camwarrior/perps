import "server-only";

import {
  notionalFromBase,
  rangeStart,
  slicePoints,
  sumBars,
  timestampToMs,
  volumeWeekStart,
  type ChartPoint,
  type ChartRange,
  type ChartSeries,
  type ChartsPayload,
} from "@/lib/chart-series";
import { fetchJson } from "@/lib/http";
import { asArray, asRecord, asString, parseNumber, publicError } from "@/lib/number";
import { parsePerpMeta } from "@/lib/txflow-parse";

const RISE_MARKETS = "https://api.rise.trade/v1/markets";
const TX_INFO = "https://rpc.txflow.com/info";
const LLAMA_OI = "https://api.llama.fi/overview/open-interest";
const CACHE_MS = 10 * 60 * 1000;
const DAY_NS = "86400000000000";

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

function windowFor(range: ChartRange, now: number): { startMs: number; endMs: number } {
  const start = range === "1S" ? volumeWeekStart(now) : rangeStart(range, now);
  return { startMs: start ?? Date.UTC(2025, 0, 1), endMs: now };
}

async function riseMarketIds(): Promise<string[]> {
  const payload = await fetchJson(RISE_MARKETS, { timeoutMs: 12_000 });
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

async function riseVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "GET /v1/markets/id/{id}/trading-view-data";
  const note = "Notional USDC estimado: volumen base × cierre, sumado entre mercados. Cada barra es un día UTC. La última puede ir incompleta.";
  try {
    const ids = await riseMarketIds();
    const { startMs, endMs } = windowFor(range, now);
    const interval = DAY_NS;
    const bars = await mapPool(ids, 10, async (id) => {
      try {
        const payload = await fetchJson(
          `${RISE_MARKETS.replace(/\/markets$/, "")}/markets/id/${id}/trading-view-data?interval=${interval}&from=${startMs}000000&to=${endMs}000000`,
          { timeoutMs: 12_000 },
        );
        return readRiseBars(payload);
      } catch {
        return null;
      }
    });
    const failed = bars.filter((item) => item == null).length;
    const points = sumBars(bars.filter((item): item is ChartPoint[] => item != null).flat());
    if (points.length === 0) return emptySeries(source, "RISEx no trajo velas en esta ventana.", "USDC");
    const partial = failed > 0 ? ` Serie parcial: faltan ${failed} de ${ids.length} mercados.` : "";
    return okSeries(points, "USDC", source, note + partial);
  } catch (error) {
    return emptySeries(source, `RISEx no respondió (${publicError(error)}).`, "USDC");
  }
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

async function txCoins(): Promise<string[]> {
  const payload = await fetchJson(TX_INFO, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-version": "2026-08-16" },
    body: JSON.stringify({ type: "perpMeta", includeDelisted: false }),
    timeoutMs: 12_000,
  });
  return parsePerpMeta(payload)
    .filter((item) => !item.delisted && !item.halt)
    .map((item) => item.base);
}

async function txVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "POST /info candleSnapshot";
  const note = "Notional USDC estimado: volumen base × cierre, sumado entre perpetuos. Cada barra es un día UTC. La última puede ir incompleta.";
  try {
    const coins = await txCoins();
    const { startMs, endMs } = windowFor(range, now);
    const interval = "1d" as const;
    const bars = await mapPool(coins, 12, async (coin) => {
      try {
        const payload = await fetchJson(TX_INFO, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-version": "2026-08-16" },
          body: JSON.stringify({
            type: "candleSnapshot",
            req: { coin, interval, startTime: startMs, endTime: endMs },
          }),
          timeoutMs: 12_000,
        });
        return readTxBars(payload);
      } catch {
        return null;
      }
    });
    const failed = bars.filter((item) => item == null).length;
    const points = sumBars(bars.filter((item): item is ChartPoint[] => item != null).flat());
    if (points.length === 0) return emptySeries(source, "Txflow no trajo velas en esta ventana.", "USDC");
    const partial = failed > 0 ? ` Serie parcial: faltan ${failed} de ${coins.length} mercados.` : "";
    return okSeries(points, "USDC", source, note + partial);
  } catch (error) {
    return emptySeries(source, `Txflow no respondió (${publicError(error)}).`, "USDC");
  }
}

async function llamaOi(): Promise<{ risex: ChartPoint[]; txflow: ChartPoint[] }> {
  if (llamaCache && Date.now() - llamaCache.at < CACHE_MS) return llamaCache.points;
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
  const points = { risex, txflow };
  llamaCache = { at: Date.now(), points };
  return points;
}

async function oiSeries(name: "risex" | "txflow", range: ChartRange, now: number): Promise<ChartSeries> {
  const source = "DefiLlama · overview/open-interest";
  const note = "Notional USD publicado por DefiLlama. La API del venue no trae esta serie. No es el OI mark×base de este tablero.";
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
  if (hit && now - hit.at < CACHE_MS) return hit.data;
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
