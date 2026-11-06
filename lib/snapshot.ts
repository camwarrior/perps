import "server-only";

import { io } from "next/cache";

import { fetchRisex } from "@/lib/risex";
import { fetchTxflow } from "@/lib/txflow";
import type { Snapshot } from "@/lib/types";

const TTL_MS = 8_000;

let cached: { at: number; data: Snapshot } | null = null;
let inflight: Promise<Snapshot> | null = null;

export async function getSnapshot(): Promise<Snapshot> {
  await io();
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.data;
  if (inflight) return inflight;

  inflight = Promise.all([fetchRisex(), fetchTxflow()])
    .then(([risex, txflow]) => {
      const data: Snapshot = { generatedAt: Date.now(), venues: { risex, txflow } };
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
