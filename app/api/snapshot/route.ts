import { getSnapshot } from "@/lib/snapshot";

export async function GET() {
  const snapshot = await getSnapshot();
  return Response.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
