import { getWalletWeek } from "@/lib/wallet";
import { isWalletAddress } from "@/lib/wallet-types";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address") ?? "";
  if (!isWalletAddress(address)) {
    return Response.json(
      { error: "Wallet inválida. Usa 0x y 40 caracteres hex." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const report = await getWalletWeek(address);
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
