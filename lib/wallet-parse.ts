import { asInt, asRecord, parseNumber } from "@/lib/number";
import type { WalletVenueResult } from "@/lib/wallet-types";

export const TXFLOW_FILL_PAGE = 2_000;
export const TXFLOW_FILL_PAGES = 2;

export type FillRow = {
  px: number | null;
  sz: number | null;
  time: number | null;
};

export function parseRiseVolume(payload: unknown): number {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const volume = parseNumber(data?.total_volume);
  if (volume == null) throw new Error("RISEx no trajo total_volume");
  return volume;
}

export function parseFillPage(payload: unknown): { rows: FillRow[]; hasMore: boolean; total: number | null } {
  const root = asRecord(payload);
  if (!root || root.success === false) {
    throw new Error(typeof root?.message === "string" ? root.message : "userFills rechazado");
  }
  const data = asRecord(root.data);
  const list = Array.isArray(data?.data) ? data.data : null;
  if (!list) throw new Error("userFills sin filas");
  const rows: FillRow[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    rows.push({
      px: parseNumber(row.px),
      sz: parseNumber(row.sz),
      time: parseNumber(row.time),
    });
  }
  return {
    rows,
    hasMore: data?.hasMore === true,
    total: asInt(data?.total),
  };
}

/** Notional USDC of perp fills inside [startMs, endMs). Null when the read stopped early. */
export function volumeFromFills(
  pages: Array<{ rows: FillRow[]; hasMore: boolean; total: number | null }>,
  startMs: number,
  endMs: number,
): { volumeUsdc: number | null; total: number | null; truncated: boolean } {
  let volume = 0;
  let truncated = false;
  let total: number | null = null;
  for (const page of pages) {
    total = page.total ?? total;
    for (const row of page.rows) {
      if (row.time == null || row.time < startMs || row.time >= endMs) continue;
      if (row.px == null || row.sz == null) continue;
      volume += Math.abs(row.px * row.sz);
    }
    if (page.hasMore) truncated = true;
  }
  if (pages.length === 0) return { volumeUsdc: null, total, truncated: true };
  const last = pages[pages.length - 1];
  if (last && !last.hasMore) truncated = false;
  if (truncated) return { volumeUsdc: null, total, truncated: true };
  return { volumeUsdc: volume, total, truncated: false };
}

export function riseVenue(volumeUsdc: number): WalletVenueResult {
  return {
    ok: true,
    error: null,
    volumeUsdc,
    volumeNote: "Notional USDC. RISEx agrega trades y liquidaciones en esta ventana.",
    oiAvgUsdc: null,
    oiNote: "RISEx no publica el OI promedio de la semana UTC. El promedio ponderado que sí existe es de 24h, 7d, 30d o all-time.",
  };
}

export function txflowVenue(volumeUsdc: number | null, total: number | null): WalletVenueResult {
  if (volumeUsdc == null) {
    const count = total == null ? "muchos" : total.toLocaleString("en-US");
    return {
      ok: true,
      error: null,
      volumeUsdc: null,
      volumeNote: `Txflow reporta ${count} fills en la semana. No se suma el notional: la lectura se corta en ${TXFLOW_FILL_PAGE * TXFLOW_FILL_PAGES} para no saturar la API.`,
      oiAvgUsdc: null,
      oiNote: "Txflow no publica el OI promedio de la semana. El nocional abierto es un snapshot y no se usa como promedio.",
    };
  }
  return {
    ok: true,
    error: null,
    volumeUsdc,
    volumeNote: "Notional USDC. Suma de |precio × tamaño| de los fills de perpetuos en la ventana.",
    oiAvgUsdc: null,
    oiNote: "Txflow no publica el OI promedio de la semana. El nocional abierto es un snapshot y no se usa como promedio.",
  };
}

export function failedVenue(message: string): WalletVenueResult {
  return {
    ok: false,
    error: message,
    volumeUsdc: null,
    volumeNote: "",
    oiAvgUsdc: null,
    oiNote: "",
  };
}
