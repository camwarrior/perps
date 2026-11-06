// A cold pull walks every traded perp three at a time; leave room for Txflow's backoff.
export const maxDuration = 60;

import { getCharts } from "@/lib/charts";
import { chartResponseCache, isChartRange } from "@/lib/chart-series";

/**
 * Daily series are public and the same for every visitor.
 * A payload with points, including one missing only a handful of markets, stays at the CDN
 * for 5 minutes and can be served stale for a day. A venue that did not answer is kept 20 seconds.
 *
 * Cache-Control alone is not enough on this route. It reads the query string, so with
 * cacheComponents the response is dynamic, and the CDN-facing s-maxage was observed stripped
 * down to `public, max-age=0` at the browser. CDN-Cache-Control and Vercel-CDN-Cache-Control
 * are the headers the CDN actually applies.
 */
export async function GET(request: Request) {
  const range = new URL(request.url).searchParams.get("range") ?? "1S";
  if (!isChartRange(range)) {
    return Response.json(
      { error: "Temporalidad inválida. Usa 1S, 1M, 3M, 1A o ALL." },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "CDN-Cache-Control": "no-store",
          "Vercel-CDN-Cache-Control": "no-store",
        },
      },
    );
  }
  const charts = await getCharts(range);
  const cache = chartResponseCache(charts);
  return Response.json(charts, {
    headers: {
      "Cache-Control": cache.browser,
      "CDN-Cache-Control": cache.cdn,
      "Vercel-CDN-Cache-Control": cache.cdn,
    },
  });
}
