import "server-only";

import { cacheLife } from "next/cache";

import {
  rangeStart,
  slicePoints,
  toTwoSidedOi,
  volumeWeekStart,
  type ChartPoint,
  type ChartRange,
  type ChartSeries,
  type ChartsPayload,
} from "@/lib/chart-series";
import { fetchJson } from "@/lib/http";
import { asArray, asRecord, parseNumber, publicError } from "@/lib/number";
import { getVenueVolume, RISE_VOLUME_SOURCE, TX_VOLUME_SOURCE } from "@/lib/volume-live";
import type { VolumeResolution } from "@/lib/volume-history";

const LLAMA_OI = "https://api.llama.fi/overview/open-interest";
const CACHE_MS = 10 * 60 * 1000;
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

function volumeSeries(built: VolumeResolution, range: ChartRange, now: number, source: string, venue: string): ChartSeries {
  const startMs = range === "1S" ? volumeWeekStart(now) : rangeStart(range, now);
  const points = slicePoints(built.points, startMs);
  const note = [built.note, ...built.extras].filter(Boolean).join(" ");
  if (points.length === 0) {
    return emptySeries(source, built.extras[0] ?? `${venue} no trajo volumen en esta ventana.`, "USDC");
  }
  return okSeries(points, "USDC", source, note);
}

async function riseVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  return volumeSeries(await getVenueVolume("risex", now), range, now, RISE_VOLUME_SOURCE, "RISEx");
}

async function txVolume(range: ChartRange, now: number): Promise<ChartSeries> {
  return volumeSeries(await getVenueVolume("txflow", now), range, now, TX_VOLUME_SOURCE, "Txflow");
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
