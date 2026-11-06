import { getTickers, toTickerQuotes } from "@/lib/txflow";

function parseIdList(raw: string | null): number[] {
  if (!raw) throw new Error("ids");
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 20) throw new Error("ids");
  const ids = parts.map((part) => {
    if (!/^\d{1,7}$/.test(part)) throw new Error("ids");
    const id = Number(part);
    if (id < 1) throw new Error("ids");
    return id;
  });
  return [...new Set(ids)];
}

export async function GET(request: Request) {
  let ids: number[];
  try {
    ids = parseIdList(new URL(request.url).searchParams.get("ids"));
  } catch {
    return Response.json({ error: "ids inválidos" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const rows = await getTickers(ids);
  const at = Date.now();
  return Response.json(toTickerQuotes(rows, at), {
    headers: { "Cache-Control": "no-store" },
  });
}
