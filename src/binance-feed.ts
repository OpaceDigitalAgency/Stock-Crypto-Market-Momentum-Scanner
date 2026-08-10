import { scoreCandidate } from "./engine";
import { isLeveragedToken, isStableQuoteBase, SessionActivityTracker } from "./activity";
import type { Candidate, Filters } from "./types";

type RollingTickerMessage = {
  s: string;
  c: string;
  P: string;
  q: string;
  E: number;
};

type DetailTickerMessage = RollingTickerMessage & {
  b: string;
  a: string;
};

type BinanceMessage =
  | { kind: "universe"; tickers: RollingTickerMessage[] }
  | { kind: "detail"; ticker: DetailTickerMessage }
  | { kind: "ack" }
  | { kind: "shutdown" }
  | { kind: "invalid" };

export const BINANCE_MARKET_ENDPOINTS = [
  "wss://data-stream.binance.vision/ws",
  "wss://stream.binance.com:443/ws",
  "wss://stream.binance.com:9443/ws"
] as const;

const UNIVERSE_STREAM = "!ticker_1d@arr";
const MAX_DETAIL_STREAMS = 160;
const MAX_RESULTS = 80;
const CORE_CONFIRMATION_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const WARMUP_MS = 4_000;

export interface BinanceCoverage {
  eligiblePairs: number;
  detailPairs: number;
  maximumDetailPairs: number;
}

export function parseBinanceMessage(raw: string): BinanceMessage {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const tickers = parsed.filter(isRollingTicker);
      return tickers.length ? { kind: "universe", tickers } : { kind: "invalid" };
    }
    if (!parsed || typeof parsed !== "object") return { kind: "invalid" };
    const message = parsed as Record<string, unknown>;
    if (message.e === "serverShutdown") return { kind: "shutdown" };
    if (message.result === null && "id" in message) return { kind: "ack" };
    return isDetailTicker(message) ? { kind: "detail", ticker: message } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function selectMomentumSymbols(tickers: RollingTickerMessage[], filters: Filters, limit = MAX_DETAIL_STREAMS) {
  const eligible = tickers.filter(isEligibleUsdtTicker);
  const priority = CORE_CONFIRMATION_SYMBOLS.filter((symbol) => eligible.some((ticker) => ticker.s === symbol));
  const ranked = eligible
    .filter((ticker) => !priority.includes(ticker.s))
    .sort((a, b) => {
      const aQualifies = Number(a.P) >= filters.minChange && Number(a.q) >= filters.minQuoteVolumeMillions * 1_000_000 ? 1 : 0;
      const bQualifies = Number(b.P) >= filters.minChange && Number(b.q) >= filters.minQuoteVolumeMillions * 1_000_000 ? 1 : 0;
      if (aQualifies !== bQualifies) return bQualifies - aQualifies;
      const movementDifference = Number(b.P) - Number(a.P);
      return movementDifference || Number(b.q) - Number(a.q);
    })
    .map((ticker) => ticker.s);
  return [...priority, ...ranked].slice(0, limit);
}

function isRollingTicker(value: unknown): value is RollingTickerMessage {
  if (!value || typeof value !== "object") return false;
  const ticker = value as Record<string, unknown>;
  return typeof ticker.s === "string" && typeof ticker.c === "string" && typeof ticker.P === "string"
    && typeof ticker.q === "string" && typeof ticker.E === "number";
}

function isDetailTicker(value: Record<string, unknown>): value is DetailTickerMessage {
  return isRollingTicker(value) && typeof (value as Record<string, unknown>).b === "string"
    && typeof (value as Record<string, unknown>).a === "string";
}

function isEligibleUsdtTicker(ticker: RollingTickerMessage) {
  if (!ticker.s.endsWith("USDT")) return false;
  const base = ticker.s.slice(0, -4);
  return Boolean(base) && !isStableQuoteBase(base) && !isLeveragedToken(base)
    && [ticker.c, ticker.P, ticker.q].every((value) => Number.isFinite(Number(value)));
}

export class BinanceFeed {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: number;
  private openTimer?: number;
  private healthTimer?: number;
  private emitTimer?: number;
  private endpointIndex = 0;
  private lastMarketMessage = 0;
  private liveReported = false;
  private warmupUntil = 0;
  private subscriptionId = 1;
  private readonly subscribedSymbols = new Set<string>();
  private readonly discoveredSymbols = new Set<string>();
  private readonly latest = new Map<string, Candidate>();
  private readonly activity = new SessionActivityTracker();

  constructor(
    private readonly filters: () => Filters,
    private readonly onBatch: (candidates: Candidate[]) => void,
    private readonly onStatus: (status: "connecting" | "live" | "error" | "closed") => void,
    private readonly onCoverage?: (coverage: BinanceCoverage) => void
  ) {}

  connect() {
    this.stopped = false;
    this.warmupUntil = Date.now() + WARMUP_MS;
    this.clearConnectionTimers();
    this.onStatus("connecting");
    const socket = new WebSocket(BINANCE_MARKET_ENDPOINTS[this.endpointIndex]);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ method: "SUBSCRIBE", params: [UNIVERSE_STREAM], id: this.subscriptionId++ }));
      this.openTimer = window.setTimeout(() => {
        if (!this.lastMarketMessage) this.failCurrentSocket(socket);
      }, 8_000);
      this.healthTimer = window.setInterval(() => {
        if (this.lastMarketMessage && Date.now() - this.lastMarketMessage > 15_000) this.failCurrentSocket(socket);
      }, 5_000);
    });
    socket.addEventListener("message", (event) => this.consume(String(event.data), socket));
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.onStatus("error");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearConnectionTimers();
      this.onStatus("closed");
      this.scheduleReconnect();
    });
  }

  stop() {
    this.stopped = true;
    this.clearConnectionTimers();
    if (this.emitTimer) window.clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  private consume(raw: string, socket: WebSocket) {
    const message = parseBinanceMessage(raw);
    if (message.kind === "ack" || message.kind === "invalid") return;
    if (message.kind === "shutdown") {
      this.failCurrentSocket(socket);
      return;
    }

    this.lastMarketMessage = Date.now();
    if (this.openTimer) window.clearTimeout(this.openTimer);
    this.openTimer = undefined;

    if (message.kind === "universe") {
      message.tickers.filter(isEligibleUsdtTicker).forEach((ticker) => this.discoveredSymbols.add(ticker.s));
      const selected = selectMomentumSymbols(message.tickers, this.filters());
      this.subscribeToDetails(selected, socket);
      this.onCoverage?.({ eligiblePairs: this.discoveredSymbols.size, detailPairs: this.subscribedSymbols.size, maximumDetailPairs: MAX_DETAIL_STREAMS });
      return;
    }

    const ticker = message.ticker;
    if (!isEligibleUsdtTicker(ticker)) return;
    const bid = Number(ticker.b);
    const ask = Number(ticker.a);
    const price = Number(ticker.c);
    const quoteVolume = Number(ticker.q);
    if (![bid, ask, price, quoteVolume].every(Number.isFinite) || bid <= 0 || ask <= 0 || price <= 0 || ask < bid) return;
    const activity = this.activity.observe(ticker.s, quoteVolume);
    if (!activity.measured) return;

    const filters = this.filters();
    const base = {
      symbol: ticker.s,
      name: ticker.s.replace(/USDT$/, " / USDT"),
      assetClass: "crypto" as const,
      venue: "Binance",
      price,
      changePercent: Number(ticker.P),
      relativeVolume: activity.ratio,
      activityBasis: "session" as const,
      volume: quoteVolume,
      floatOrMarketCap: 0,
      catalyst: "none" as const,
      spreadPercent: ((ask - bid) / price) * 100,
      crossVenue: false,
      sourceTime: ticker.E,
      receiptTime: Date.now(),
      coverage: "single-venue" as const
    };
    this.latest.set(ticker.s, { ...base, score: scoreCandidate(base, filters) });
    this.scheduleEmit();
  }

  private subscribeToDetails(symbols: string[], socket: WebSocket) {
    const remaining = Math.max(0, MAX_DETAIL_STREAMS - this.subscribedSymbols.size);
    const additions = symbols.filter((symbol) => !this.subscribedSymbols.has(symbol)).slice(0, remaining);
    if (!additions.length || socket.readyState !== WebSocket.OPEN) return;
    additions.forEach((symbol) => this.subscribedSymbols.add(symbol));
    socket.send(JSON.stringify({
      method: "SUBSCRIBE",
      params: additions.map((symbol) => `${symbol.toLowerCase()}@ticker`),
      id: this.subscriptionId++
    }));
  }

  private scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = undefined;
      if (Date.now() < this.warmupUntil) {
        this.scheduleEmit();
        return;
      }
      const freshAfter = Date.now() - 30_000;
      const candidates = [...this.latest.values()]
        .filter((candidate) => candidate.receiptTime >= freshAfter)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS);
      if (candidates.length) {
        this.onBatch(candidates);
        if (!this.liveReported) {
          this.liveReported = true;
          this.onStatus("live");
        }
      }
    }, 1_000);
  }

  private failCurrentSocket(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.onStatus("error");
    socket.close();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.endpointIndex = (this.endpointIndex + 1) % BINANCE_MARKET_ENDPOINTS.length;
      this.lastMarketMessage = 0;
      this.liveReported = false;
      this.subscribedSymbols.clear();
      this.discoveredSymbols.clear();
      this.connect();
    }, 2_000);
  }

  private clearConnectionTimers() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.openTimer) window.clearTimeout(this.openTimer);
    if (this.healthTimer) window.clearInterval(this.healthTimer);
    this.reconnectTimer = undefined;
    this.openTimer = undefined;
    this.healthTimer = undefined;
  }
}
