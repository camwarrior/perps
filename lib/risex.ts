import "server-only";

import { fetchJson } from "@/lib/http";
import { emptyTotals, summarize } from "@/lib/market";
import { publicError } from "@/lib/number";
import { parseRisex } from "@/lib/risex-parse";
import type { VenueBook } from "@/lib/types";

const MARKETS_URL = "https://api.rise.trade/v1/markets";

export { parseRisex } from "@/lib/risex-parse";

function failed(message: string): VenueBook {
  return {
    id: "risex",
    label: "RISEx",
    ok: false,
    error: message,
    fetchedAt: Date.now(),
    exchangeTime: null,
    source: "GET /v1/markets",
    notes: [],
    totals: emptyTotals(),
    markets: [],
  };
}

export async function fetchRisex(): Promise<VenueBook> {
  try {
    const payload = await fetchJson(MARKETS_URL);
    const parsed = parseRisex(payload);
    const notes: string[] = [];
    if (parsed.omitted > 0) {
      notes.push(
        parsed.omitted === 1
          ? "1 mercado inactivo omitido."
          : `${parsed.omitted} mercados inactivos omitidos.`,
      );
    }
    return {
      id: "risex",
      label: "RISEx",
      ok: true,
      error: null,
      fetchedAt: Date.now(),
      exchangeTime: parsed.exchangeTime,
      source: "GET /v1/markets",
      notes,
      totals: summarize(parsed.markets),
      markets: parsed.markets,
    };
  } catch (error) {
    return failed(`RISEx no respondió (${publicError(error)}).`);
  }
}
