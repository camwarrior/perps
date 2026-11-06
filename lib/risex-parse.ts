import { derive } from "@/lib/market";
import { asArray, asRecord, asString, baseFromSymbol, intervalLabelFromNanos, parseNumber } from "@/lib/number";
import type { Market } from "@/lib/types";

export function parseRisex(payload: unknown): { markets: Market[]; exchangeTime: number | null; omitted: number } {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const rows = asArray(data?.markets);
  if (!rows) throw new Error("respuesta sin mercados");

  const cachedAt = parseNumber(data?.cached_at);
  const exchangeTime = cachedAt == null ? null : Math.round(cachedAt * 1000);
  const markets: Market[] = [];
  let omitted = 0;

  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    if (item.active !== true) {
      omitted += 1;
      continue;
    }
    const symbol = asString(item.display_name) ?? asString(item.base_asset_symbol);
    const id = asString(item.market_id) ?? (typeof item.market_id === "number" ? String(item.market_id) : null);
    if (!symbol || !id) continue;

    const last = parseNumber(item.last_price);
    const changeAbs = parseNumber(item.change_24h);
    const prevDayPx = last != null && changeAbs != null ? last - changeAbs : null;
    const current = parseNumber(item.current_funding_rate);
    const eight = parseNumber(item.funding_rate_8h);

    markets.push(
      derive({
        venue: "risex",
        id,
        symbol,
        base: baseFromSymbol(symbol),
        active: true,
        last,
        mark: parseNumber(item.mark_price),
        index: parseNumber(item.index_price),
        changeAbs,
        changePct: null,
        high: parseNumber(item.high_24h),
        low: parseNumber(item.low_24h),
        volumeUsdc: parseNumber(item.quote_volume_24h),
        volumeBase: null,
        oiBase: parseNumber(item.open_interest),
        oiUsdc: null,
        // Decimal fraction per funding_interval. Shown as percent.
        fundingPct: current == null ? null : current * 100,
        fundingInterval: intervalLabelFromNanos(item.funding_interval),
        funding8hPct: eight == null ? null : eight * 100,
        prevDayPx,
      }),
    );
  }

  return { markets, exchangeTime, omitted };
}
