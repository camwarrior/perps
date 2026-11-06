import "server-only";

import { fetchJson } from "@/lib/http";
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

async function readRisex(address: string, startMs: number, endMs: number): Promise<WalletVenueResult> {
  const volumeUrl = `${RISE_VOLUME}?address=${address}&start_time=${msToNanos(startMs)}&end_time=${msToNanos(endMs)}`;
  const headerUrl = `${RISE_HEADER}?account=${address}`;
  const [volumeResult, headerResult] = await Promise.allSettled([
    fetchJson(volumeUrl, { timeoutMs: 12_000 }),
    fetchJson(headerUrl, { timeoutMs: 12_000 }),
  ]);
  if (volumeResult.status === "rejected") {
    return failedVenue(`RISEx no respondió (${publicError(volumeResult.reason)}).`);
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
      });
      const parsed = parseFillPage(payload);
      pages.push(parsed);
      if (!parsed.hasMore) break;
    }
  } catch (error) {
    return failedVenue(`Txflow no respondió (${publicError(error)}).`);
  }
  const summed = volumeFromFills(pages, startMs, endMs);
  return txflowVenue(summed.volumeUsdc, summed.total);
}

export async function getWalletWeek(rawAddress: string, now = Date.now()): Promise<WalletReport> {
  const address = normalizeWallet(rawAddress);
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
