export type AssetClass = "stocks" | "crypto";

export type Coverage = "demo" | "single-venue" | "cross-venue-checked" | "delayed";

export interface Candidate {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  venue: string;
  price: number;
  changePercent: number;
  relativeVolume: number;
  activityBasis: "demo" | "session" | "historical";
  volume: number;
  floatOrMarketCap: number | null;
  catalyst: "confirmed" | "unverified" | "none";
  spreadPercent: number;
  crossVenue: boolean;
  score: number;
  sourceTime: number;
  receiptTime: number;
  coverage: Coverage;
  momentum5m?: number | null;
  momentum1h?: number | null;
  depthQuote?: number | null;
  detailState?: "loading" | "available" | "unavailable" | "queued";
  lifecycleState?: "current" | "cooling" | "stale";
  dataMode?: string;
  marketState?: string;
  missing?: string[];
  catalystState?: "checking" | "confirmed" | "no-evidence" | "source-unavailable";
  catalystEvidence?: { title: string; url: string; publishedAt: string }[];
  catalystNews?: { count: number; url?: string; title?: string; publisher?: string; kind?: string };
  technical?: {
    retracementPercent: number;
    greenVolumeDominant: boolean;
    aboveVwap: boolean;
    aboveEma9: boolean;
    toppingTail: boolean;
    firstCandleBreak: boolean;
  };
}

export interface Filters {
  minPrice: number;
  maxPrice: number;
  minChange: number;
  minChange5m: number;
  minChange1h: number;
  minRelativeVolume: number;
  maxFloatMillions: number;
  minQuoteVolumeMillions: number;
  maxSpreadPercent: number;
  requireCatalyst: boolean;
}

export interface JournalEntry {
  id: string;
  createdAt: string;
  symbol: string;
  assetClass: AssetClass;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  risk: number;
  outcome?: number;
  note: string;
}
