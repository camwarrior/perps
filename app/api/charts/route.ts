import { getCharts } from "@/lib/charts";
import { isChartRange } from "@/lib/chart-series";

export async function GET(request: Request) {
  const range = new URL(request.url).searchParams.get("range") ?? "1S";
  if (!isChartRange(range)) {
    return Response.json(
      { error: "Temporalidad inválida. Usa 1S, 1M, 3M, 1A o ALL." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const charts = await getCharts(range);
  return Response.json(charts, { headers: { "Cache-Control": "no-store" } });
}
