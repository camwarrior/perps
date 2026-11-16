import "server-only";

import { io } from "next/cache";

import { emptyTotals } from "@/lib/market";
import { fetchRisex } from "@/lib/risex";
import { fetchTxflow } from "@/lib/txflow";
import type { Snapshot, VenueBook } from "@/lib/types";

/** Coalesce bursts. A Txflow refresh in progress expires quickly so the next poll sees new markets. */
const READY_TTL_MS = 8_000;
const REFRESHING_TTL_MS = 1_000;
/** RISEx must not hold the page open. Its own client retries on the next poll. */
const RISEX_DEADLINE_MS = 2_500;

let cached: { at: number; ttl: number; data: Snapshot } | null = null;
let inflight: Promise<Snapshot> | null = null;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback());
      },
    );
  });
}

function risexSlow(): VenueBook {
  return {
    id: "risex",
    label: "RISEx",
    ok: false,
    error: "RISEx tardó demasiado. Se reintenta en el próximo sondeo.",
    fetchedAt: Date.now(),
    exchangeTime: null,
    source: "GET /v1/markets",
    notes: [],
    totals: emptyTotals(),
    markets: [],
  };
}

function txflowSlow(): VenueBook {
  return {
    id: "txflow",
    label: "Txflow",
    ok: true,
    error: null,
    fetchedAt: null,
    exchangeTime: null,
    source: "rpc.txflow.com/info",
    notes: ["Txflow se está actualizando."],
    refreshing: true,
    totals: emptyTotals(),
    markets: [],
  };
}

export async function getSnapshot(): Promise<Snapshot> {
  await io();
  const now = Date.now();
  if (cached && now - cached.at < cached.ttl) return cached.data;
  if (inflight) return inflight;

  inflight = Promise.all([
    withDeadline(fetchRisex(), RISEX_DEADLINE_MS, risexSlow),
    withDeadline(fetchTxflow(), RISEX_DEADLINE_MS, txflowSlow),
  ])
    .then(([risex, txflow]) => {
      const data: Snapshot = { generatedAt: Date.now(), venues: { risex, txflow } };
      cached = { at: Date.now(), ttl: txflow.refreshing ? REFRESHING_TTL_MS : READY_TTL_MS, data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
