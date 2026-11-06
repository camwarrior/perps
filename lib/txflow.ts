import "server-only";

import { fetchJson } from "@/lib/http";
import { emptyTotals, summarize } from "@/lib/market";
import { publicError } from "@/lib/number";
import {
  assembleTxflow,
  parseAssetCtxs,
  parseMarketTicker,
  parsePerpMeta,
  parseWebData,
  type CtxRow,
  type MetaInstrument,
  type TickerRow,
  type WebRow,
} from "@/lib/txflow-parse";
import type { TickerQuote, VenueBook } from "@/lib/types";

const INFO_URL = "https://rpc.txflow.com/info";
const WS_URL = "wss://rpc.txflow.com/ws";
const API_VERSION = "2026-08-16";
const EMPTY_USER = "0x0000000000000000000000000000000000000001";
const META_TTL_MS = 5 * 60 * 1000;
const TICKER_TTL_MS = 12_000;
const TOP_FALLBACK = 20;

let metaCache: { at: number; data: MetaInstrument[] } | null = null;
const tickerCache = new Map<number, { at: number; row: TickerRow }>();

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

function readAllAssetCtxs(timeoutMs: number): Promise<Map<number, CtxRow>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("allAssetCtxs timeout"))), timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          method: "subscribe",
          type: "allAssetCtxs",
          subscription: { type: "allAssetCtxs" },
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      try {
        const message = JSON.parse(text) as { channel?: string; message?: string; data?: { ctxs?: unknown } };
        if (message.channel === "error") {
          finish(() => reject(new Error(message.message || "allAssetCtxs")));
          return;
        }
        if (message.channel === "allAssetCtxs" && Array.isArray(message.data?.ctxs)) {
          finish(() => resolve(parseAssetCtxs(message.data?.ctxs)));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("error", () => finish(() => reject(new Error("allAssetCtxs socket"))));
    ws.addEventListener("close", () => finish(() => reject(new Error("allAssetCtxs closed"))));
  });
}

/** perpMeta, cached for five minutes. Shared with the chart series so both do not spend the rate limit. */
export async function loadMeta(): Promise<MetaInstrument[]> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.data;
  const payload = await fetchJson(INFO_URL, { ...infoInit({ type: "perpMeta", includeDelisted: false }), retries: 2 });
  const data = parsePerpMeta(payload);
  metaCache = { at: Date.now(), data };
  return data;
}

/** Last good webData2, kept so one rate-limited poll does not blank 24 h volume on screen. */
let webCache: { at: number; rows: WebRow[] } | null = null;
const WEB_STALE_MS = 3 * 60 * 1000;

async function loadWeb(): Promise<{ rows: WebRow[]; staleMs: number | null }> {
  try {
    const payload = await fetchJson(INFO_URL, { ...infoInit({ type: "webData2", user: EMPTY_USER }), retries: 1 });
    const rows = parseWebData(payload);
    webCache = { at: Date.now(), rows };
    return { rows, staleMs: null };
  } catch (error) {
    const age = webCache ? Date.now() - webCache.at : Infinity;
    if (webCache && age < WEB_STALE_MS) return { rows: webCache.rows, staleMs: age };
    throw error;
  }
}

/**
 * Bases of the perpetuals that traded in the last 24 h, for the chart history.
 * Txflow lists hundreds of perps; pulling candles for the idle ones only spends its rate limit.
 * Falls back to every listed perp when webData2 is not available.
 */
export async function tradedCoins(): Promise<string[]> {
  const meta = (await loadMeta()).filter((item) => !item.delisted && !item.halt);
  let rows: WebRow[] | null = webCache && Date.now() - webCache.at < 60_000 ? webCache.rows : null;
  if (!rows) {
    try {
      rows = (await loadWeb()).rows;
    } catch {
      rows = null;
    }
  }
  if (!rows) return meta.map((item) => item.base);
  const traded = new Set(rows.filter((row) => (row.volume ?? 0) > 0).map((row) => row.instrumentId));
  return meta.filter((item) => traded.has(item.index)).map((item) => item.base);
}

async function fetchOneTicker(id: number): Promise<TickerRow> {
  const payload = await fetchJson(INFO_URL, infoInit({ type: "marketTicker", instrumentId: id }));
  return parseMarketTicker(payload, id);
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

export async function getTickers(ids: number[]): Promise<TickerRow[]> {
  const now = Date.now();
  const fresh: TickerRow[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    const hit = tickerCache.get(id);
    if (hit && now - hit.at < TICKER_TTL_MS) fresh.push(hit.row);
    else missing.push(id);
  }
  if (missing.length === 0) return fresh;
  const fetched = await mapPool(missing, 5, async (id) => {
    try {
      const row = await fetchOneTicker(id);
      tickerCache.set(id, { at: Date.now(), row });
      return row;
    } catch {
      return null;
    }
  });
  return [...fresh, ...fetched.filter((row): row is TickerRow => row != null)];
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

function topIds(meta: MetaInstrument[] | null, web: WebRow[] | null, limit: number): number[] {
  const volumes = new Map((web ?? []).map((row) => [row.instrumentId, row.volume ?? -1]));
  const ids = meta
    ? meta.filter((item) => !item.delisted && !item.halt).map((item) => item.index)
    : (web ?? []).filter((row) => row.instrumentId < 10_000).map((row) => row.instrumentId);
  return ids
    .toSorted((left, right) => (volumes.get(right) ?? -1) - (volumes.get(left) ?? -1))
    .slice(0, limit);
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
  const [metaResult, webResult, ctxResult] = await Promise.allSettled([
    loadMeta(),
    loadWeb(),
    readAllAssetCtxs(4_500),
  ]);

  const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
  const web = webResult.status === "fulfilled" ? webResult.value.rows : null;
  const webStaleMs = webResult.status === "fulfilled" ? webResult.value.staleMs : null;
  const ctxs = ctxResult.status === "fulfilled" ? ctxResult.value : null;
  const notes: string[] = [];

  if (!meta && !web) {
    return failed(`Txflow no respondió (${publicError(metaResult.status === "rejected" ? metaResult.reason : webResult.status === "rejected" ? webResult.reason : "sin datos")}).`);
  }

  let tickers: Map<number, TickerRow> | null = null;
  if (!ctxs) {
    try {
      const rows = await getTickers(topIds(meta, web, TOP_FALLBACK));
      tickers = new Map(rows.map((row) => [row.id, row]));
      notes.push(
        web
          ? "allAssetCtxs no respondió. Mark, oracle, OI y funding solo en los 20 de mayor volumen (marketTicker)."
          : "allAssetCtxs no respondió. Mark, oracle, OI y funding solo en 20 mercados (marketTicker).",
      );
    } catch (error) {
      notes.push(`allAssetCtxs no respondió y marketTicker falló (${publicError(error)}).`);
    }
  }
  if (!web) notes.push("webData2 no respondió. Sin volumen ni máximo/mínimo 24h.");
  if (webStaleMs != null) {
    notes.push(`webData2 no respondió en este refresco: volumen y máximo/mínimo 24h son de hace ${Math.max(1, Math.round(webStaleMs / 1000))} s.`);
  }
  if (!meta) notes.push("perpMeta no respondió. Símbolos tomados de webData2.");

  const assembled = assembleTxflow({ meta, web, ctxs, tickers });
  if (assembled.omitted > 0) {
    notes.push(
      assembled.omitted === 1 ? "1 mercado inactivo omitido." : `${assembled.omitted} mercados inactivos omitidos.`,
    );
  }
  if (assembled.markets.length === 0) return failed("Txflow respondió sin perpetuos.");

  const source = [meta ? "perpMeta" : null, web ? "webData2" : null, ctxs ? "allAssetCtxs" : tickers ? "marketTicker" : null]
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
