import "server-only";

import { fetchJson, HttpError } from "@/lib/http";
import { publicError } from "@/lib/number";
import {
  failedVenue,
  parseFillPage,
  parseRiseExposure7d,
  parseRiseVolume,
  RISE_OI_NOTE,
  riseVenue,
  TXFLOW_FILL_PAGE,
  TXFLOW_FILL_PAGES,
  txflowVenue,
  volumeFromFills,
} from "@/lib/wallet-parse";
import { normalizeWallet, totalVolume, type WalletReport, type WalletVenueResult } from "@/lib/wallet-types";
import { msToNanos, utcWeek } from "@/lib/week";

const RISE_VOLUME = "https://api.rise.trade/v1/stats/user-volume";
const RISE_HEADER = "https://api.rise.trade/v1/portfolio/header";
const TX_INFO = "https://rpc.txflow.com/info";
/** A finished lookup is reused for a minute: pressing Consultar again does not spend the rate limit. */
const REPORT_TTL_MS = 60 * 1000;
const reports = new Map<string, { at: number; report: WalletReport }>();
const lookups = new Map<string, Promise<WalletReport>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function venueError(venue: "RISEx" | "Txflow", error: unknown): string {
  if (error instanceof HttpError && error.status === 429) {
    return `${venue} está limitando las consultas en este momento. Vuelve a consultar en unos segundos.`;
  }
  return `${venue} no respondió (${publicError(error)}).`;
}

async function readRisex(address: string, startMs: number, endMs: number): Promise<WalletVenueResult> {
  const volumeUrl = `${RISE_VOLUME}?address=${address}&start_time=${msToNanos(startMs)}&end_time=${msToNanos(endMs)}`;
  const headerUrl = `${RISE_HEADER}?account=${address}`;
  const [volumeResult, headerResult] = await Promise.allSettled([
    fetchJson(volumeUrl, { timeoutMs: 12_000, retries: 2 }),
    fetchJson(headerUrl, { timeoutMs: 12_000, retries: 2 }),
  ]);
  if (volumeResult.status === "rejected") {
    return failedVenue(venueError("RISEx", volumeResult.reason));
  }
  let volumeUsdc: number;
  try {
    volumeUsdc = parseRiseVolume(volumeResult.value);
  } catch (error) {
    return failedVenue(`RISEx no respondió (${publicError(error)}).`);
  }
  if (headerResult.status === "rejected") {
    return riseVenue(volumeUsdc, null, `RISEx no trajo el OI promedio 7d (${publicError(headerResult.reason)}).`);
  }
  try {
    return riseVenue(volumeUsdc, parseRiseExposure7d(headerResult.value), RISE_OI_NOTE);
  } catch (error) {
    return riseVenue(volumeUsdc, null, `RISEx no trajo el OI promedio 7d (${publicError(error)}).`);
  }
}

async function readTxflow(address: string, startMs: number, endMs: number): Promise<WalletVenueResult> {
  const pages = [];
  try {
    for (let page = 0; page < TXFLOW_FILL_PAGES; page += 1) {
      // A short pause between pages, so a heavy wallet does not arrive as a burst.
      if (page > 0) await sleep(300);
      const payload = await fetchJson(TX_INFO, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-version": "2026-08-16",
        },
        body: JSON.stringify({
          type: "userFills",
          user: address,
          accountType: ["perp"],
          startTimeMs: startMs,
          endTimeMs: endMs - 1,
          limit: TXFLOW_FILL_PAGE,
          offset: page * TXFLOW_FILL_PAGE,
        }),
        timeoutMs: 12_000,
        // Txflow answers 429 to bursts, and the server shares its limit with the live book.
        retries: 4,
      });
      const parsed = parseFillPage(payload);
      pages.push(parsed);
      if (!parsed.hasMore) break;
    }
  } catch (error) {
    return failedVenue(venueError("Txflow", error));
  }
  const summed = volumeFromFills(pages, startMs, endMs);
  return txflowVenue(summed.volumeUsdc, summed.total);
}

export async function getWalletWeek(rawAddress: string, now = Date.now()): Promise<WalletReport> {
  const address = normalizeWallet(rawAddress);
  const { startMs } = utcWeek(now);
  const key = `${address}:${startMs}`;
  const hit = reports.get(key);
  if (hit && now - hit.at < REPORT_TTL_MS) return hit.report;
  const running = lookups.get(key);
  if (running) return running;
  const job = readWeek(address, now)
    .then((report) => {
      // Only complete answers are reused; a failed venue is asked again on the next press.
      if (report.venues.risex.ok && report.venues.txflow.ok) reports.set(key, { at: Date.now(), report });
      return report;
    })
    .finally(() => lookups.delete(key));
  lookups.set(key, job);
  return job;
}

async function readWeek(address: string, now: number): Promise<WalletReport> {
  const { startMs, endMs } = utcWeek(now);
  const [risex, txflow] = await Promise.all([readRisex(address, startMs, endMs), readTxflow(address, startMs, endMs)]);
  return {
    address,
    startMs,
    endMs,
    venues: { risex, txflow },
    totalVolumeUsdc: totalVolume(risex.volumeUsdc, txflow.volumeUsdc),
  };
}
