export type VenueId = "risex" | "txflow";

export type Market = {
  venue: VenueId;
  id: string;
  symbol: string;
  base: string;
  active: boolean;
  last: number | null;
  mark: number | null;
  index: number | null;
  changeAbs: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  volumeUsdc: number | null;
  volumeBase: number | null;
  oiBase: number | null;
  oiUsdc: number | null;
  /** Current funding interval, in percent (0.01 means 0.01%). */
  fundingPct: number | null;
  /** Label of the funding interval, e.g. "1h". */
  fundingInterval: string | null;
  /** Published 8h funding in percent. Null when the venue does not publish it. */
  funding8hPct: number | null;
  prevDayPx: number | null;
};

export type VenueTotals = {
  volume24hUsdc: number | null;
  openInterestUsdc: number | null;
  activeMarkets: number | null;
  listedMarkets: number | null;
};

export type VenueBook = {
  id: VenueId;
  label: string;
  ok: boolean;
  error: string | null;
  fetchedAt: number | null;
  /** Exchange cache time in ms, when the venue publishes one. */
  exchangeTime: number | null;
  source: string;
  notes: string[];
  /** When the 24 h fields were obtained, if they were carried from an earlier refresh. */
  dailyFetchedAt?: number;
  totals: VenueTotals;
  markets: Market[];
};

export type Snapshot = {
  generatedAt: number;
  venues: Record<VenueId, VenueBook>;
};

export type QuoteOverride = {
  at: number;
  last?: number;
  mark?: number;
  index?: number;
  oiBase?: number;
  fundingPct?: number;
  fundingInterval?: string;
  prevDayPx?: number;
  volumeUsdc?: number;
  high?: number;
  low?: number;
};

export type TickerQuote = {
  id: string;
  last: number | null;
  mark: number | null;
  index: number | null;
  oiBase: number | null;
  fundingPct: number | null;
  fundingInterval: string | null;
  prevDayPx: number | null;
  volumeUsdc: number | null;
  high: number | null;
  low: number | null;
};
