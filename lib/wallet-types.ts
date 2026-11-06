export type WalletVenueResult = {
  ok: boolean;
  error: string | null;
  volumeUsdc: number | null;
  volumeNote: string;
  oiAvgUsdc: number | null;
  oiNote: string;
};

export type WalletReport = {
  address: string;
  startMs: number;
  endMs: number;
  venues: {
    risex: WalletVenueResult;
    txflow: WalletVenueResult;
  };
  totalVolumeUsdc: number | null;
};

export function isWalletAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function normalizeWallet(value: string): string {
  return value.trim().toLowerCase();
}

export function totalVolume(risex: number | null, txflow: number | null): number | null {
  if (risex == null || txflow == null) return null;
  return risex + txflow;
}
