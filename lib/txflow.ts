import "server-only";

import { getCache, waitUntil, type RuntimeCache } from "@vercel/functions";

import { fetchJson, HttpError } from "@/lib/http";
import { coverage, emptyTotals, summarize } from "@/lib/market";
import { asInt, asRecord, asString, parseNumber } from "@/lib/number";
import { createIntervalLimiter, mapPool } from "@/lib/pool";
import {
  assembleTxflow,
  dueTickerIds,
  mergeStoredTickers,
  oldestTickerAt,
  parseMarketTicker,
  parsePerpMeta,
  parseWebData,
  tradableIds,
  type MetaInstrument,
  type StoredTicker,
  type TickerRow,
  type WebRow,
} from "@/lib/txflow-parse";
import type { TickerQuote, VenueBook } from "@/lib/types";

const INFO_URL = "https://rpc.txflow.com/info";
const API_VERSION = "2026-08-16";
const EMPTY_USER = "0x0000000000000000000000000000000000000001";
const META_TTL_MS = 5 * 60 * 1000;
const META_DEADLINE_MS = 1_200;
const WEB_TIMEOUT_MS = 800;
const WEB_STALE_MS = 3 * 60 * 1000;
/** A stored quote is reused for a minute, so the fan-out is not a continuous 12/s stream. */
const TICKER_FRESH_MS = 60_000;
const CACHE_READ_MS = 400;
const BOOK_TTL_SECONDS = 6 * 60 * 60;
const LOCK_MS = 25_000;
const LOCK_TTL_SECONDS = 30;
/** One background pass stays inside the function budget. The next request continues what is left. */
const REFRESH_BUDGET_MS = 22_000;
const CHUNK = 16;
/**
 * Txflow documents about 50 info requests per second. Live mainnet returned 429 near 20/s,
 * so this stays near 12/s and leaves room for candleSnapshot.
 */
const TICKER_INTERVAL_MS = 80;
const TICKER_CONCURRENCY = 8;
const TICKER_TIMEOUT_MS = 4_000;
const BOOK_KEY = "tickers";
const LOCK_KEY = "tickers-lock";

type StoredBook = { savedAt: number; rows: StoredTicker[] };

let metaCache: { at: number; data: MetaInstrument[] } | null = null;
let memoryBook: StoredBook | null = null;
let webCache: { at: number; rows: WebRow[] } | null = null;
let refreshJob: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();

const tickerSlots = createIntervalLimiter(TICKER_INTERVAL_MS);

function infoInit(body: unknown, timeoutMs = 8_000): RequestInit & { timeoutMs: number } {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-version": API_VERSION,
    },
    body: JSON.stringify(body),
    timeoutMs,
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function remoteCache(): RuntimeCache | null {
  if (process.env.VERCEL !== "1" && !process.env.RUNTIME_CACHE_ENDPOINT) return null;
  try {
    return getCache({ namespace: "camwarrior-perps-txflow-v1" });
  } catch {
    return null;
  }
}

function parseTickerRow(value: unknown, id: number): TickerRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const interval = asString(row.interval);
  return {
    id,
    last: parseNumber(row.last),
    mark: parseNumber(row.mark),
    index: parseNumber(row.index),
    oi: parseNumber(row.oi),
    funding: parseNumber(row.funding),
    interval,
    prev: parseNumber(row.prev),
    volume: parseNumber(row.volume),
    changeAbs: parseNumber(row.changeAbs),
    changePct: parseNumber(row.changePct),
  };
}

function parseStored(value: unknown): StoredBook | null {
  const root = asRecord(value);
  if (!root || typeof root.savedAt !== "number" || !Array.isArray(root.rows)) return null;
  const rows: StoredTicker[] = [];
  for (const item of root.rows) {
    const record = asRecord(item);
    const id = asInt(record?.id);
    const at = typeof record?.at === "number" ? record.at : null;
    if (id == null || at == null) continue;
    const row = parseTickerRow(record?.row, id);
    if (!row) continue;
    rows.push({ id, at, row });
  }
  return { savedAt: root.savedAt, rows };
}

async function readRemoteBook(): Promise<StoredBook | null> {
  const cache = remoteCache();
  if (!cache) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      cache.get(BOOK_KEY),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CACHE_READ_MS);
      }),
    ]);
    return parseStored(value);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Memory first. A remote copy is used only when this instance has nothing newer. */
async function readBook(): Promise<StoredBook | null> {
  const local = memoryBook;
  // The instance that just wrote the book does not need to read it back.
  if (local && Date.now() - local.savedAt < 5_000) return local;
  const remote = await readRemoteBook();
  if (!remote) return local;
  if (!local || remote.savedAt > local.savedAt) {
    memoryBook = remote;
    return remote;
  }
  return local;
}

/** Merge by quote time so a concurrent writer cannot roll a market backwards. Memory updates immediately. */
function rememberBook(rows: readonly StoredTicker[], savedAt: number): void {
  const base = memoryBook?.rows ?? [];
  const map = new Map(base.map((item) => [item.id, item]));
  for (const item of rows) {
    const prev = map.get(item.id);
    if (!prev || item.at >= prev.at) map.set(item.id, item);
  }
  const book: StoredBook = {
    savedAt: Math.max(memoryBook?.savedAt ?? 0, savedAt),
    rows: [...map.values()],
  };
  memoryBook = book;
  const write = writeChain.then(async () => {
    const cache = remoteCache();
    if (!cache) return;
    try {
      await cache.set(BOOK_KEY, book, { ttl: BOOK_TTL_SECONDS, name: "txflow-tickers" });
    } catch {
      /* This instance still serves memoryBook. */
    }
  });
  writeChain = write.then(
    () => undefined,
    () => undefined,
  );
}

async function claimLock(): Promise<boolean> {
  const cache = remoteCache();
  if (!cache) return true;
  try {
    const current = asRecord(await cache.get(LOCK_KEY));
    const at = typeof current?.at === "number" ? current.at : 0;
    if (at > 0 && Date.now() - at < LOCK_MS) return false;
    await cache.set(LOCK_KEY, { at: Date.now() }, { ttl: LOCK_TTL_SECONDS, name: "txflow-ticker-lock" });
    return true;
  } catch {
    return true;
  }
}

async function releaseLock(): Promise<void> {
  const cache = remoteCache();
  if (!cache) return;
  try {
    await cache.delete(LOCK_KEY);
  } catch {
    /* The lock TTL releases it. */
  }
}

/** perpMeta, cached for five minutes. The volume series uses the same book so both do not spend the rate limit. */
export async function loadMeta(): Promise<MetaInstrument[]> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.data;
  const payload = await fetchJson(INFO_URL, { ...infoInit({ type: "perpMeta", includeDelisted: false }), retries: 2 });
  const data = parsePerpMeta(payload);
  metaCache = { at: Date.now(), data };
  return data;
}

async function loadMetaFast(): Promise<MetaInstrument[] | null> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.data;
  try {
    return await withDeadline(loadMeta(), META_DEADLINE_MS);
  } catch {
    return metaCache?.data ?? null;
  }
}

async function loadWeb(): Promise<{ rows: WebRow[]; staleMs: number | null } | null> {
  try {
    const payload = await fetchJson(INFO_URL, {
      ...infoInit({ type: "webData2", user: EMPTY_USER }, WEB_TIMEOUT_MS),
      retries: 0,
    });
    const rows = parseWebData(payload);
    webCache = { at: Date.now(), rows };
    return { rows, staleMs: null };
  } catch {
    const age = webCache ? Date.now() - webCache.at : Infinity;
    if (webCache && age < WEB_STALE_MS) return { rows: webCache.rows, staleMs: age };
    return null;
  }
}

async function fetchOneTicker(id: number): Promise<TickerRow> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await tickerSlots.take();
    try {
      const payload = await fetchJson(INFO_URL, infoInit({ type: "marketTicker", instrumentId: id }, TICKER_TIMEOUT_MS));
      return parseMarketTicker(payload, id);
    } catch (error) {
      if (attempt === 0 && error instanceof HttpError && error.status === 429) {
        await tickerSlots.pause(Math.min(error.retryAfterMs ?? 1_000, 2_000));
        continue;
      }
      throw error;
    }
  }
  throw new Error("marketTicker");
}

async function refreshTickerBook(ids: number[]): Promise<void> {
  if (!(await claimLock())) return;
  const started = Date.now();
  try {
    let previous = (await readBook())?.rows ?? [];
    const due = dueTickerIds(ids, previous, Date.now(), TICKER_FRESH_MS);
    for (let offset = 0; offset < due.length; offset += CHUNK) {
      if (Date.now() - started > REFRESH_BUDGET_MS) break;
      const chunk = due.slice(offset, offset + CHUNK);
      const fetched = await mapPool(chunk, TICKER_CONCURRENCY, async (id) => {
        try {
          return await fetchOneTicker(id);
        } catch {
          return null;
        }
      });
      const at = Date.now();
      previous = mergeStoredTickers(previous, chunk, fetched, at);
      rememberBook(previous, at);
    }
  } finally {
    await releaseLock();
  }
}

/** Start one refresh if none is running. The caller does not wait for it. */
function scheduleTickerRefresh(ids: number[]): void {
  if (ids.length === 0 || refreshJob) return;
  const job = refreshTickerBook(ids).finally(() => {
    if (refreshJob === job) refreshJob = null;
  });
  refreshJob = job;
  try {
    waitUntil(job);
  } catch {
    /* Outside a request the promise still runs in this process. */
  }
}

export async function getTickers(ids: number[]): Promise<TickerRow[]> {
  const now = Date.now();
  const stored = (await readBook())?.rows ?? [];
  const byId = new Map(stored.map((item) => [item.id, item]));
  const fresh: TickerRow[] = [];
  const missing: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = byId.get(id);
    if (hit && now - hit.at < TICKER_FRESH_MS) fresh.push(hit.row);
    else missing.push(id);
  }
  if (missing.length === 0) return fresh;
  const fetched = await mapPool(missing, TICKER_CONCURRENCY, async (id) => {
    try {
      return await fetchOneTicker(id);
    } catch {
      return null;
    }
  });
  const at = Date.now();
  const merged = mergeStoredTickers(stored, missing, fetched, at);
  if (merged.length > 0) rememberBook(merged, at);
  const found = new Map<number, TickerRow>();
  for (const row of fetched) {
    if (row) found.set(row.id, row);
  }
  // A failed id keeps its previous quote instead of disappearing from this answer.
  for (const id of missing) {
    if (found.has(id)) continue;
    const kept = byId.get(id);
    if (kept) found.set(id, kept.row);
  }
  return [...fresh, ...found.values()];
}

export function toTickerQuotes(rows: TickerRow[], at: number): { fetchedAt: number; quotes: TickerQuote[] } {
  return {
    fetchedAt: at,
    quotes: rows.map((row) => ({
      id: String(row.id),
      last: row.last,
      mark: row.mark,
      index: row.index,
      oiBase: row.oi,
      fundingPct: row.funding,
      fundingInterval: row.interval,
      prevDayPx: row.prev,
      volumeUsdc: row.volume,
      high: null,
      low: null,
    })),
  };
}

function failed(message: string): VenueBook {
  return {
    id: "txflow",
    label: "Txflow",
    ok: false,
    error: message,
    fetchedAt: Date.now(),
    exchangeTime: null,
    source: "rpc.txflow.com/info",
    notes: [],
    totals: emptyTotals(),
    markets: [],
  };
}

function loadingBook(message: string): VenueBook {
  return {
    id: "txflow",
    label: "Txflow",
    ok: true,
    error: null,
    fetchedAt: null,
    exchangeTime: null,
    source: "rpc.txflow.com/info",
    notes: [message],
    refreshing: true,
    totals: emptyTotals(),
    markets: [],
  };
}

/**
 * Returns as soon as meta and the cached ticker book are in hand.
 * The marketTicker fan-out never runs on this path.
 */
export async function fetchTxflow(): Promise<VenueBook> {
  const webPromise = loadWeb();
  const [meta, stored] = await Promise.all([loadMetaFast(), readBook()]);
  const webResult = await webPromise;
  const rows = stored?.rows ?? [];

  if (!meta && !webResult && rows.length === 0) {
    return failed("Txflow no respondió (sin universo en caché).");
  }

  const ids = meta ? tradableIds(meta) : [];
  const due = ids.length > 0 ? dueTickerIds(ids, rows, Date.now(), TICKER_FRESH_MS) : [];
  const refreshing = due.length > 0;
  if (refreshing) scheduleTickerRefresh(ids);

  const web = webResult?.rows ?? null;
  const webStaleMs = webResult?.staleMs ?? null;
  const tickers = new Map(rows.map((item) => [item.id, item.row]));
  const notes: string[] = [];

  if (refreshing && tickers.size === 0 && !web) {
    notes.push("Txflow se está actualizando. El volumen aparece en cuanto llega el primer grupo de mercados.");
  } else if (refreshing) {
    notes.push("Txflow se está actualizando en segundo plano. Los números son los últimos guardados.");
  }
  if (!web && (tickers.size > 0 || refreshing)) {
    notes.push("webData2 no respondió. Volumen, mark, oracle, OI y funding salen de marketTicker.");
  } else if (!web) {
    notes.push("webData2 no respondió. Sin volumen ni máximo/mínimo 24h.");
  }
  if (webStaleMs != null) {
    notes.push(
      `webData2 no respondió en este refresco. Máximo y mínimo 24h son de hace ${Math.max(1, Math.round(webStaleMs / 1000))} s.`,
    );
  }
  if (!meta) notes.push("perpMeta no respondió. Símbolos tomados de webData2.");

  const assembled = assembleTxflow({
    meta,
    web,
    ctxs: null,
    tickers: tickers.size > 0 ? tickers : null,
    webStale: webStaleMs != null,
  });
  if (assembled.markets.length === 0) {
    if (refreshing) return { ...loadingBook(notes[0] ?? "Txflow se está actualizando."), notes };
    return failed("Txflow respondió sin perpetuos.");
  }
  if (assembled.omitted > 0) {
    notes.push(assembled.omitted === 1 ? "1 mercado inactivo omitido." : `${assembled.omitted} mercados inactivos omitidos.`);
  }
  const covered = coverage(assembled.markets);
  if (covered.volume < assembled.markets.length) {
    notes.push(`Volumen 24h de ${covered.volume} de ${assembled.markets.length} mercados. La suma usa los que contestaron.`);
  }
  const oldest = oldestTickerAt(rows, ids.length > 0 ? ids : rows.map((item) => item.id));

  const source = [meta ? "perpMeta" : null, web && webStaleMs == null ? "webData2" : null, tickers.size > 0 ? "marketTicker" : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return {
    id: "txflow",
    label: "Txflow",
    ok: true,
    error: null,
    fetchedAt: oldest,
    exchangeTime: null,
    source: source || "rpc.txflow.com/info",
    notes,
    refreshing,
    totals: summarize(assembled.markets),
    markets: assembled.markets,
  };
}
