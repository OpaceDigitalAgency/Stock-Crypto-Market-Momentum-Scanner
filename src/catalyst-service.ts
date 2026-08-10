import { NASDAQ_HALTS_URL, parseNasdaqHalts } from "./catalyst-nasdaq";
import { parseSecSubmission, parseSecTickerMap, SEC_TICKER_URL, secSubmissionUrl } from "./catalyst-sec";
import type { CatalystEvidence, CatalystLookupRequest, CatalystReport, CatalystSourceStatus } from "./catalyst-types";

export interface CatalystServiceOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  secUserAgent?: string;
  cache?: CatalystSourceCache;
}

export interface CatalystSourceCache {
  get(key: string, nowMs: number): unknown | undefined;
  set(key: string, value: unknown, expiresAt: number): void;
}

export function createMemoryCatalystCache(): CatalystSourceCache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    get(key, nowMs) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= nowMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, expiresAt) {
      entries.set(key, { value, expiresAt });
    }
  };
}

const MAX_SYMBOLS = 8;
const MAX_LOOKBACK_DAYS = 14;

export function validateCatalystRequest(value: unknown): Required<CatalystLookupRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request must be a JSON object");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "symbols" && key !== "lookbackDays")) throw new Error("Request contains an unsupported field");
  if (!Array.isArray(request.symbols) || request.symbols.length < 1 || request.symbols.length > MAX_SYMBOLS) {
    throw new Error(`symbols must contain between 1 and ${MAX_SYMBOLS} entries`);
  }
  const symbols = [...new Set(request.symbols.map((symbol) => {
    if (typeof symbol !== "string") throw new Error("Each symbol must be a string");
    const normalised = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,15}$/.test(normalised)) throw new Error(`Invalid symbol: ${symbol}`);
    return normalised;
  }))];
  const lookbackDays = request.lookbackDays === undefined ? 3 : Number(request.lookbackDays);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > MAX_LOOKBACK_DAYS) {
    throw new Error(`lookbackDays must be an integer from 1 to ${MAX_LOOKBACK_DAYS}`);
  }
  return { symbols, lookbackDays };
}

async function fetchJson(request: typeof fetch, url: string, headers: HeadersInit) {
  const response = await request(url, { headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fetchText(request: typeof fetch, url: string) {
  const response = await request(url, { headers: { accept: "application/rss+xml, application/xml;q=0.9" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response.text();
}

async function cached<T>(cache: CatalystSourceCache | undefined, key: string, nowMs: number, ttlMs: number, load: () => Promise<T>) {
  const hit = cache?.get(key, nowMs);
  if (hit !== undefined) return hit as T;
  const value = await load();
  cache?.set(key, value, nowMs + ttlMs);
  return value;
}

export async function lookupOfficialCatalysts(input: unknown, options: CatalystServiceOptions = {}): Promise<CatalystReport[]> {
  const { symbols, lookbackDays } = validateCatalystRequest(input);
  const request = options.fetch ?? fetch;
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const checkedAt = now.toISOString();
  const earliest = new Date(now);
  earliest.setUTCDate(earliest.getUTCDate() - lookbackDays);
  const earliestFilingDate = earliest.toISOString().slice(0, 10);
  const evidence = new Map(symbols.map((symbol) => [symbol, [] as CatalystEvidence[]]));
  const statuses = new Map(symbols.map((symbol) => [symbol, [] as CatalystSourceStatus[]]));

  try {
    // Nasdaq asks consumers not to poll this once-per-minute feed more than once a minute.
    const haltXml = await cached(options.cache, NASDAQ_HALTS_URL, nowMs, 60_000, () => fetchText(request, NASDAQ_HALTS_URL));
    const haltEvidence = parseNasdaqHalts(haltXml, checkedAt);
    for (const symbol of symbols) {
      evidence.get(symbol)?.push(...haltEvidence.filter((item) => item.symbol === symbol));
      statuses.get(symbol)?.push({ source: "nasdaq-halts", available: true, checkedAt, message: "Official halt feed checked" });
    }
  } catch {
    for (const symbol of symbols) statuses.get(symbol)?.push({ source: "nasdaq-halts", available: false, checkedAt, message: "Nasdaq halt feed unavailable" });
  }

  const secUserAgent = options.secUserAgent?.trim();
  if (!secUserAgent) {
    for (const symbol of symbols) statuses.get(symbol)?.push({ source: "sec-edgar", available: false, checkedAt, message: "SEC_USER_AGENT is required" });
  } else {
    const secHeaders = { "user-agent": secUserAgent, accept: "application/json", "accept-encoding": "gzip, deflate" };
    try {
      const tickerPayload = await cached(options.cache, SEC_TICKER_URL, nowMs, 24 * 60 * 60 * 1_000, () => fetchJson(request, SEC_TICKER_URL, secHeaders));
      const tickerMap = parseSecTickerMap(tickerPayload);
      await Promise.all(symbols.map(async (symbol) => {
        const match = tickerMap.get(symbol);
        if (!match) {
          statuses.get(symbol)?.push({ source: "sec-edgar", available: false, checkedAt, message: "Symbol is not resolved by the SEC ticker map" });
          return;
        }
        try {
          const submissionUrl = secSubmissionUrl(match.cik);
          const submission = await cached(options.cache, submissionUrl, nowMs, 30_000, () => fetchJson(request, submissionUrl, secHeaders));
          evidence.get(symbol)?.push(...parseSecSubmission(submission, symbol, checkedAt, earliestFilingDate));
          statuses.get(symbol)?.push({ source: "sec-edgar", available: true, checkedAt, message: "Official submissions checked" });
        } catch {
          statuses.get(symbol)?.push({ source: "sec-edgar", available: false, checkedAt, message: "SEC submissions unavailable" });
        }
      }));
    } catch {
      for (const symbol of symbols) statuses.get(symbol)?.push({ source: "sec-edgar", available: false, checkedAt, message: "SEC ticker service unavailable" });
    }
  }

  return symbols.map((symbol) => {
    const symbolEvidence = evidence.get(symbol) ?? [];
    const symbolStatuses = statuses.get(symbol) ?? [];
    return {
      symbol,
      state: symbolEvidence.length ? "confirmed" : symbolStatuses.every((source) => source.available) ? "no-evidence" : "source-unavailable",
      checkedAt,
      evidence: symbolEvidence.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
      sources: symbolStatuses
    };
  });
}
