// The whole perp book is walked once for any closed day that is not stored yet.
export const maxDuration = 180;

import { io } from "next/cache";

import { getCharts } from "@/lib/charts";

/**
 * 00:05 UTC. Recomputes yesterday if it is not in the seed or the runtime store,
 * then leaves that close there. The open day is calculated and not stored.
 * Visitors hit the same path on /api/charts; this only makes midnight not wait for one.
 */
export async function GET() {
  await io();
  const charts = await getCharts("1S");
  const risex = charts.venues.risex.volume;
  const txflow = charts.venues.txflow.volume;
  return Response.json(
    {
      ok: risex.ok && txflow.ok,
      generatedAt: charts.generatedAt,
      risex: { points: risex.points.length, note: risex.note },
      txflow: { points: txflow.points.length, note: txflow.note },
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    },
  );
}
