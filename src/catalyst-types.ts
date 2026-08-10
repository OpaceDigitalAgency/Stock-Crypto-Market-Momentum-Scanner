export type CatalystState = "checking" | "confirmed" | "no-evidence" | "source-unavailable";

export type CatalystSource = "sec-edgar" | "nasdaq-halts";

export interface CatalystEvidence {
  id: string;
  symbol: string;
  source: CatalystSource;
  sourceLabel: string;
  kind: "filing" | "trading-halt";
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  receivedAt: string;
  confidence: "official";
  metadata: Record<string, string>;
}

export interface CatalystSourceStatus {
  source: CatalystSource;
  available: boolean;
  checkedAt: string;
  message: string;
}

export interface CatalystReport {
  symbol: string;
  state: CatalystState;
  checkedAt: string;
  evidence: CatalystEvidence[];
  sources: CatalystSourceStatus[];
}

export interface CatalystLookupRequest {
  symbols: string[];
  /** Maximum age of SEC filings to return. Defaults to three calendar days. */
  lookbackDays?: number;
}

export const checkingCatalystReport = (symbol: string, now = new Date()): CatalystReport => ({
  symbol: symbol.trim().toUpperCase(),
  state: "checking",
  checkedAt: now.toISOString(),
  evidence: [],
  sources: []
});

