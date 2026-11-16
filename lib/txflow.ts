import "server-only";

import { fetchJson, HttpError } from "@/lib/http";
import { coverage, emptyTotals, summarize } from "@/lib/market";
import { publicError } from "@/lib/number";
import { createIntervalLimiter, mapPool } from "@/lib/pool";
import {
  assembleTxflow,
  parseMarketTicker,
  parsePerpMeta,
  parseWebData,
  tradableIds,
  type MetaInstrument,
  type TickerRow,
  type WebRow,
} from "@/lib/txflow-parse";
import type { TickerQuote, VenueBook } from "@/lib/types";

const INFO_URL = "https://rpc.txflow.com/info";
const API_VERSION = "2026-08-16";
const EMPTY_USER = "0x0000000000000000000000000000000000000001";
const META_TTL_MS = 5 * 60 * 1000;
const TICKER_TTL_MS = 12_000;
/** A complete ticker book is reused so the 10 s poll does not fan out again immediately. */
const BOOK_FRESH_MS = 20_000;
const BOOK_STALE_MS = 3 * 60 * 1000;
/**
 * Txflow documents about 50 info requests per second. Live mainnet still returned
 * 429 near 20/s, so the fan-out stays near 12/s and leaves the rest of the budget
 * for candleSnapshot on the same host.
 */
const TICKER_INTERVAL_MS = 80;
const TICKER_CONCURRENCY = 8;
const TICKER_TIMEOUT_MS = 4_000;
/** Stop scheduling new tickers after this. Calls already in flight keep their own timeout. */
const TICKER_DEADLINE_MS = 30_000;
const TICKER_ATTEMPTS = 2;
/** One try, short timeout: a disabled webData2 must not hold the book. */
const WEB_TIMEOUT_MS = 2_500;
const WEB_STALE_MS = 3 * 60 * 1000;

let metaCache: { at: number; data: MetaInstrument[] } | null = null;
const tickerCache = new Map<number, { at: number; row: TickerRow }>();
let bookCache: { key: string; at: number; rows: TickerRow[] } | null = null;
let bookInflight: Promise<{ rows: TickerRow[]; staleMs: number | null }> | null = null;
let bookInflightKey = "";

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

/** perpMeta, cached for five minutes. The volume series uses the same book so both do not spend the rate limit. */
export async function loadMeta(): Promise<MetaInstrument[]> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.data;
  const payload = await fetchJson(INFO_URL, { ...infoInit({ type: "perpMeta", includeDelisted: false }), retries: 2 });
  const data = parsePerpMeta(payload);
  metaCache = { at: Date.now(), data };
  return data;
}

/** Last good webData2, kept so one failed poll can still supply high and low. */
let webCache: { at: number; rows: WebRow[] } | null = null;

async function loadWeb(): Promise<{ rows: WebRow[]; staleMs: number | null }> {
  try {
    const payload = await fetchJson(INFO_URL, {
      ...infoInit({ type: "webData2", user: EMPTY_USER }, WEB_TIMEOUT_MS),
      retries: 0,
    });
    const rows = parseWebData(payload);
    webCache = { at: Date.now(), rows };
    return { rows, staleMs: null };
  } catch (error) {
    const age = webCache ? Date.now() - webCache.at : Infinity;
    if (webCache && age < WEB_STALE_MS) return { rows: webCache.rows, staleMs: age };
    throw error;
  }
}

async function fetchOneTicker(id: number): Promise<TickerRow> {
  await tickerSlots.take();
  try {
    const payload = await fetchJson(INFO_URL, infoInit({ type: "marketTicker", instrumentId: id }, TICKER_TIMEOUT_MS));
    return parseMarketTicker(payload, id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      await tickerSlots.pause(Math.min(error.retryAfterMs ?? 1_000, 2_000));
    }
    throw error;
  }
}

export async function getTickers(ids: number[]): Promise<TickerRow[]> {
  const now = Date.now();
  const fresh: TickerRow[] = [];
  const missing: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = tickerCache.get(id);
    if (hit && now - hit.at < TICKER_TTL_MS) fresh.push(hit.row);
    else missing.push(id);
  }
  if (missing.length === 0) return fresh;
  const found = new Map<number, TickerRow>();
  let pending = missing;
  for (let attempt = 0; attempt < TICKER_ATTEMPTS && pending.length > 0; attempt += 1) {
    const fetched = await mapPool(
      pending,
      TICKER_CONCURRENCY,
      async (id) => {
        try {
          const row = await fetchOneTicker(id);
          tickerCache.set(id, { at: Date.now(), row });
          return row;
        } catch {
          return null;
        }
      },
      { deadlineMs: TICKER_DEADLINE_MS },
    );
    for (const row of fetched) {
      if (row) found.set(row.id, row);
    }
    pending = pending.filter((id) => !found.has(id));
  }
  return [...fresh, ...found.values()];
}

async function loadBookTickers(ids: number[]): Promise<{ rows: TickerRow[]; staleMs: number | null }> {
  const key = ids.join(",");
  const now = Date.now();
  if (bookCache && bookCache.key === key && ids.length > 0 && bookCache.rows.length === ids.length && now - bookCache.at < BOOK_FRESH_MS) {
    return { rows: bookCache.rows, staleMs: null };
  }
  if (bookInflight && bookInflightKey === key) return bookInflight;

  const job = (async () => {
    const rows = await getTickers(ids);
    if (rows.length === ids.length && ids.length > 0) {
      bookCache = { key, at: Date.now(), rows };
      return { rows, staleMs: null as number | null };
    }
    const cached = bookCache && bookCache.key === key ? bookCache : null;
    const age = cached ? Date.now() - cached.at : Infinity;
    // A thin answer (timeouts, rate limit) must not replace a recent full book.
    if (cached && age < BOOK_STALE_MS && rows.length * 2 < cached.rows.length) {
      return { rows: cached.rows, staleMs: age };
    }
    return { rows, staleMs: null as number | null };
  })();

  bookInflight = job;
  bookInflightKey = key;
  void job.finally(() => {
    if (bookInflight === job) bookInflight = null;
  });
  return job;
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

export async function fetchTxflow(): Promise<VenueBook> {
  const webPromise = loadWeb().then(
    (value) => ({ ok: true as const, rows: value.rows, staleMs: value.staleMs }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );

  let meta: MetaInstrument[] | null = null;
  let metaReason: unknown = null;
  try {
    meta = await loadMeta();
  } catch (reason) {
    metaReason = reason;
  }

  let tickerRows: TickerRow[] = [];
  let tickerStaleMs: number | null = null;
  let tickerRequested = 0;
  if (meta) {
    const ids = tradableIds(meta);
    tickerRequested = ids.length;
    const loaded = await loadBookTickers(ids);
    tickerRows = loaded.rows;
    tickerStaleMs = loaded.staleMs;
  }

  const webResult = await webPromise;
  const web = webResult.ok ? webResult.rows : null;
  const webStaleMs = webResult.ok ? webResult.staleMs : null;

  if (!meta && !web) {
    const reason = metaReason ?? (webResult.ok ? "sin datos" : webResult.reason);
    return failed(`Txflow no respondió (${publicError(reason)}).`);
  }

  const notes: string[] = [];
  const tickers = new Map(tickerRows.map((row) => [row.id, row]));

  if (!web && tickerRows.length > 0) {
    notes.push("webData2 no respondió. Volumen, mark, oracle, OI y funding salen de marketTicker.");
  } else if (!web) {
    notes.push("webData2 no respondió. Sin volumen ni máximo/mínimo 24h.");
  }
  if (webStaleMs != null && tickerRows.length === 0) {
    notes.push(
      `webData2 no respondió en este refresco: volumen y máximo/mínimo 24h son de hace ${Math.max(1, Math.round(webStaleMs / 1000))} s.`,
    );
  } else if (webStaleMs != null) {
    notes.push(
      `webData2 no respondió en este refresco. Máximo y mínimo 24h son de hace ${Math.max(1, Math.round(webStaleMs / 1000))} s.`,
    );
  }
  if (!meta) notes.push("perpMeta no respondió. Símbolos tomados de webData2.");
  if (tickerStaleMs != null) {
    notes.push(
      `marketTicker no respondió en este refresco: volumen, mark, oracle y OI son de hace ${Math.max(1, Math.round(tickerStaleMs / 1000))} s.`,
    );
  }

  const assembled = assembleTxflow({
    meta,
    web,
    ctxs: null,
    tickers: tickerRequested > 0 ? tickers : null,
    webStale: webStaleMs != null,
  });
  if (assembled.omitted > 0) {
    notes.push(assembled.omitted === 1 ? "1 mercado inactivo omitido." : `${assembled.omitted} mercados inactivos omitidos.`);
  }
  const covered = coverage(assembled.markets);
  if (tickerStaleMs == null && covered.volume < assembled.markets.length) {
    notes.push(`Volumen 24h de ${covered.volume} de ${assembled.markets.length} mercados. La suma usa los que contestaron.`);
  }
  if (assembled.markets.length === 0) return failed("Txflow respondió sin perpetuos.");

  const source = [meta ? "perpMeta" : null, web ? "webData2" : null, tickerRows.length > 0 ? "marketTicker" : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return {
    id: "txflow",
    label: "Txflow",
    ok: true,
    error: null,
    fetchedAt: Date.now(),
    exchangeTime: null,
    source,
    notes,
    totals: summarize(assembled.markets),
    markets: assembled.markets,
  };
}
