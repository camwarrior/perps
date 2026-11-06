import { getCharts } from "@/lib/charts";
import { isChartRange, type ChartsPayload } from "@/lib/chart-series";

/**
 * Daily series are public and the same for every visitor, so the CDN keeps them.
 * A complete payload is fresh for 5 minutes and served stale for up to a day while it
 * refreshes in the background; one with a failed venue is kept only 20 seconds.
 */
function cacheControl(charts: ChartsPayload): string {
  const series = [charts.venues.risex.volume, charts.venues.risex.oi, charts.venues.txflow.volume, charts.venues.txflow.oi];
  const complete = series.every((item) => item.ok && !/el último intento falló|Serie parcial/.test(item.note));
  return complete
    ? "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
    : "public, max-age=0, s-maxage=20, stale-while-revalidate=60";
}

export async function GET(request: Request) {
  const range = new URL(request.url).searchParams.get("range") ?? "1S";
  if (!isChartRange(range)) {
    return Response.json(
      { error: "Temporalidad inválida. Usa 1S, 1M, 3M, 1A o ALL." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const charts = await getCharts(range);
  return Response.json(charts, { headers: { "Cache-Control": cacheControl(charts) } });
}
