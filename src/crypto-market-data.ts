export const BINANCE_PUBLIC_REST_ENDPOINT = "https://data-api.binance.vision";
export const COINBASE_PUBLIC_WEBSOCKET_ENDPOINT = "wss://advanced-trade-ws.coinbase.com";

const FIVE_MINUTES_MS = 5 * 60 * 1_000;

export type ObservationState = "available" | "stale" | "unavailable";

export interface Observation<T> {
  state: ObservationState;
  value?: T;
  source: string;
  sourceTime?: number;
  receiptTime?: number;
  ageMs?: number;
  methodology: string;
  reason?: string;
}

export interface VenueQuote {
  venue: "Binance" | "Coinbase";
  pair: string;
  price: number;
  sourceTime: number;
  receiptTime: number;
}

export interface BinanceCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
}

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  venue: "Binance";
  pair: string;
  bids: BookLevel[];
  asks: BookLevel[];
  sourceTime: number;
  receiptTime: number;
}

export interface MomentumValue {
  percent: number;
  requestedWindowMs: number;
  measuredWindowMs: number;
  referencePrice: number;
  referenceTime: number;
}

export interface ActivityValue {
  ratio: number;
  latestQuoteVolume: number;
  baselineQuoteVolume: number;
  baselineCandles: number;
  intervalMinutes: 5;
}

export interface LiquidityValue {
  spreadPercent: number;
  spreadBasisPoints: number;
  bidDepthQuote: number;
  askDepthQuote: number;
  minimumSideDepthQuote: number;
  depthBandBasisPoints: number;
  passes: boolean;
}

export interface CrossVenueValue {
  confirmed: boolean;
  differencePercent: number;
  differenceBasisPoints: number;
  maximumDifferencePercent: number;
  binancePair: string;
  coinbasePair: string;
}

export interface CryptoMetricRules {
  quoteStaleAfterMs: number;
  candleStaleAfterMs: number;
  bookStaleAfterMs: number;
  maximumCrossVenueDifferencePercent: number;
  maximumSpreadPercent: number;
  minimumDepthPerSideQuote: number;
  depthBandBasisPoints: number;
  activityBaselineCandles: number;
}

export interface CryptoMarketSnapshot {
  symbol: string;
  asOf: number;
  momentum: {
    fiveMinutes: Observation<MomentumValue>;
    oneHour: Observation<MomentumValue>;
    twentyFourHours: Observation<MomentumValue>;
  };
  activity: Observation<ActivityValue>;
  liquidity: Observation<LiquidityValue>;
  crossVenue: Observation<CrossVenueValue>;
  marketCap: Observation<never>;
  catalyst: Observation<never>;
}

export const DEFAULT_CRYPTO_METRIC_RULES: CryptoMetricRules = {
  quoteStaleAfterMs: 15_000,
  candleStaleAfterMs: 10 * 60 * 1_000,
  bookStaleAfterMs: 5_000,
  maximumCrossVenueDifferencePercent: 1,
  maximumSpreadPercent: 0.5,
  minimumDepthPerSideQuote: 10_000,
  depthBandBasisPoints: 25,
  activityBaselineCandles: 12
};

export function buildBinanceKlinesUrl(symbol: string, limit = 300) {
  const safeSymbol = normaliseBinanceSymbol(symbol);
  const safeLimit = Math.max(14, Math.min(1_000, Math.trunc(limit)));
  return `${BINANCE_PUBLIC_REST_ENDPOINT}/api/v3/klines?symbol=${safeSymbol}&interval=5m&limit=${safeLimit}`;
}

export function buildBinanceDetailStreams(symbol: string) {
  const safeSymbol = normaliseBinanceSymbol(symbol).toLowerCase();
  return [
    `${safeSymbol}@bookTicker`,
    `${safeSymbol}@depth20@100ms`,
    `${safeSymbol}@kline_5m`,
    `${safeSymbol}@ticker_1h`,
    `${safeSymbol}@ticker_1d`
  ];
}

export function parseBinanceKlines(payload: unknown): BinanceCandle[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row): BinanceCandle[] => {
    if (!Array.isArray(row) || row.length < 8) return [];
    const [openTime, open, high, low, close, baseVolume, closeTime, quoteVolume] = row;
    const values = [openTime, open, high, low, close, baseVolume, closeTime, quoteVolume].map(Number);
    if (!values.every(Number.isFinite)) return [];
    const [parsedOpenTime, parsedOpen, parsedHigh, parsedLow, parsedClose, parsedBaseVolume, parsedCloseTime, parsedQuoteVolume] = values;
    if (parsedOpenTime < 0 || parsedCloseTime <= parsedOpenTime || parsedOpen <= 0 || parsedHigh <= 0
      || parsedLow <= 0 || parsedClose <= 0 || parsedBaseVolume < 0 || parsedQuoteVolume < 0) return [];
    return [{
      openTime: parsedOpenTime,
      closeTime: parsedCloseTime,
      open: parsedOpen,
      high: parsedHigh,
      low: parsedLow,
      close: parsedClose,
      baseVolume: parsedBaseVolume,
      quoteVolume: parsedQuoteVolume
    }];
  }).sort((a, b) => a.openTime - b.openTime);
}

export function parseBinancePartialBook(
  payload: unknown,
  pair: string,
  sourceTime: number,
  receiptTime: number
): OrderBookSnapshot | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const bids = parseLevels(record.bids ?? record.b);
  const asks = parseLevels(record.asks ?? record.a);
  if (!bids.length || !asks.length || !Number.isFinite(sourceTime) || !Number.isFinite(receiptTime)) return undefined;
  return {
    venue: "Binance",
    pair: normaliseBinanceSymbol(pair),
    bids: bids.sort((a, b) => b.price - a.price),
    asks: asks.sort((a, b) => a.price - b.price),
    sourceTime,
    receiptTime
  };
}

export function calculateMomentum(
  candles: BinanceCandle[],
  quote: VenueQuote | undefined,
  windowMs: number,
  now: number,
  quoteStaleAfterMs = DEFAULT_CRYPTO_METRIC_RULES.quoteStaleAfterMs
): Observation<MomentumValue> {
  const methodology = "Latest Binance price versus the nearest completed 5-minute Binance candle close at the requested lookback; measured window is reported.";
  if (!quote || quote.venue !== "Binance") return unavailable("Binance", methodology, "A Binance price is not available.");
  if (!validQuote(quote)) return unavailable("Binance", methodology, "The Binance price observation is invalid.");
  if (!Number.isFinite(windowMs) || windowMs <= 0) return unavailable("Binance", methodology, "The requested momentum window is invalid.");

  const targetTime = quote.sourceTime - windowMs;
  const completed = candles.filter((candle) => validCandle(candle) && candle.closeTime <= quote.sourceTime);
  const reference = completed.reduce<BinanceCandle | undefined>((nearest, candle) => {
    if (!nearest) return candle;
    return Math.abs(candle.closeTime - targetTime) < Math.abs(nearest.closeTime - targetTime) ? candle : nearest;
  }, undefined);
  if (!reference || Math.abs(reference.closeTime - targetTime) > FIVE_MINUTES_MS) {
    return unavailable("Binance", methodology, `No completed 5-minute candle is close enough to the ${formatWindow(windowMs)} reference time.`);
  }

  const value: MomentumValue = {
    percent: ((quote.price - reference.close) / reference.close) * 100,
    requestedWindowMs: windowMs,
    measuredWindowMs: quote.sourceTime - reference.closeTime,
    referencePrice: reference.close,
    referenceTime: reference.closeTime
  };
  return observed(value, "Binance", quote.sourceTime, quote.receiptTime, now, quoteStaleAfterMs, methodology);
}

export function calculateMeasuredActivity(
  candles: BinanceCandle[],
  now: number,
  rules: Pick<CryptoMetricRules, "activityBaselineCandles" | "candleStaleAfterMs"> = DEFAULT_CRYPTO_METRIC_RULES
): Observation<ActivityValue> {
  const methodology = "Last completed Binance 5-minute quote volume divided by the median quote volume of the preceding completed 5-minute candles.";
  const completed = candles.filter((candle) => validCandle(candle) && candle.closeTime < now).sort((a, b) => a.closeTime - b.closeTime);
  const required = Math.max(3, Math.trunc(rules.activityBaselineCandles));
  if (completed.length < required + 1) {
    return unavailable("Binance", methodology, `At least ${required + 1} completed 5-minute candles are required.`);
  }
  const latest = completed.at(-1)!;
  const baselineRows = completed.slice(-(required + 1), -1);
  const baseline = median(baselineRows.map((candle) => candle.quoteVolume));
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return unavailable("Binance", methodology, "The historical quote-volume baseline is zero or invalid.");
  }
  const value: ActivityValue = {
    ratio: latest.quoteVolume / baseline,
    latestQuoteVolume: latest.quoteVolume,
    baselineQuoteVolume: baseline,
    baselineCandles: baselineRows.length,
    intervalMinutes: 5
  };
  return observed(value, "Binance", latest.closeTime, latest.closeTime, now, rules.candleStaleAfterMs, methodology);
}

export function calculateLiquidity(
  book: OrderBookSnapshot | undefined,
  now: number,
  rules: Pick<CryptoMetricRules, "bookStaleAfterMs" | "maximumSpreadPercent" | "minimumDepthPerSideQuote" | "depthBandBasisPoints"> = DEFAULT_CRYPTO_METRIC_RULES
): Observation<LiquidityValue> {
  const methodology = "Binance top-of-book spread and visible quote-value depth on each side within the configured basis-point band; this is not full-market depth.";
  if (!book || !validBook(book)) return unavailable("Binance", methodology, "A valid Binance order-book snapshot is not available.");
  const bestBid = Math.max(...book.bids.map((level) => level.price));
  const bestAsk = Math.min(...book.asks.map((level) => level.price));
  if (bestAsk < bestBid) return unavailable("Binance", methodology, "The order book is crossed.");
  const midpoint = (bestBid + bestAsk) / 2;
  const bandFraction = Math.max(0, rules.depthBandBasisPoints) / 10_000;
  const bidFloor = midpoint * (1 - bandFraction);
  const askCeiling = midpoint * (1 + bandFraction);
  const bidDepthQuote = quoteDepth(book.bids.filter((level) => level.price >= bidFloor));
  const askDepthQuote = quoteDepth(book.asks.filter((level) => level.price <= askCeiling));
  const spreadPercent = ((bestAsk - bestBid) / midpoint) * 100;
  const minimumSideDepthQuote = Math.min(bidDepthQuote, askDepthQuote);
  const value: LiquidityValue = {
    spreadPercent,
    spreadBasisPoints: spreadPercent * 100,
    bidDepthQuote,
    askDepthQuote,
    minimumSideDepthQuote,
    depthBandBasisPoints: rules.depthBandBasisPoints,
    passes: spreadPercent <= rules.maximumSpreadPercent && minimumSideDepthQuote >= rules.minimumDepthPerSideQuote
  };
  return observed(value, "Binance", book.sourceTime, book.receiptTime, now, rules.bookStaleAfterMs, methodology);
}

export function confirmAcrossVenues(
  binance: VenueQuote | undefined,
  coinbase: VenueQuote | undefined,
  now: number,
  rules: Pick<CryptoMetricRules, "quoteStaleAfterMs" | "maximumCrossVenueDifferencePercent"> = DEFAULT_CRYPTO_METRIC_RULES
): Observation<CrossVenueValue> {
  const methodology = "Absolute Binance USDT-versus-Coinbase USD price difference; confirms price agreement only, not consolidated volume or liquidity.";
  if (!binance || !coinbase) return unavailable("Binance + Coinbase", methodology, "Both venue prices are required.");
  if (binance.venue !== "Binance" || coinbase.venue !== "Coinbase" || !validQuote(binance) || !validQuote(coinbase)) {
    return unavailable("Binance + Coinbase", methodology, "One or both venue price observations are invalid.");
  }
  const differencePercent = Math.abs(binance.price - coinbase.price) / binance.price * 100;
  const sourceTime = Math.min(binance.sourceTime, coinbase.sourceTime);
  const receiptTime = Math.min(binance.receiptTime, coinbase.receiptTime);
  const value: CrossVenueValue = {
    confirmed: differencePercent <= rules.maximumCrossVenueDifferencePercent,
    differencePercent,
    differenceBasisPoints: differencePercent * 100,
    maximumDifferencePercent: rules.maximumCrossVenueDifferencePercent,
    binancePair: binance.pair,
    coinbasePair: coinbase.pair
  };
  return observed(value, "Binance + Coinbase", sourceTime, receiptTime, now, rules.quoteStaleAfterMs, methodology);
}

export function buildCryptoMarketSnapshot(input: {
  symbol: string;
  now: number;
  candles: BinanceCandle[];
  binanceQuote?: VenueQuote;
  coinbaseQuote?: VenueQuote;
  binanceBook?: OrderBookSnapshot;
  rules?: Partial<CryptoMetricRules>;
}): CryptoMarketSnapshot {
  const rules = { ...DEFAULT_CRYPTO_METRIC_RULES, ...input.rules };
  const noVerifiedMarketCap = unavailable<never>("none", "No market-cap provider is configured.", "Market cap is unavailable; no value is estimated.");
  const noVerifiedCatalyst = unavailable<never>("none", "No verified catalyst provider is configured.", "Catalyst is unavailable; social activity is not treated as confirmation.");
  return {
    symbol: normaliseBinanceSymbol(input.symbol),
    asOf: input.now,
    momentum: {
      fiveMinutes: calculateMomentum(input.candles, input.binanceQuote, FIVE_MINUTES_MS, input.now, rules.quoteStaleAfterMs),
      oneHour: calculateMomentum(input.candles, input.binanceQuote, 60 * 60 * 1_000, input.now, rules.quoteStaleAfterMs),
      twentyFourHours: calculateMomentum(input.candles, input.binanceQuote, 24 * 60 * 60 * 1_000, input.now, rules.quoteStaleAfterMs)
    },
    activity: calculateMeasuredActivity(input.candles, input.now, rules),
    liquidity: calculateLiquidity(input.binanceBook, input.now, rules),
    crossVenue: confirmAcrossVenues(input.binanceQuote, input.coinbaseQuote, input.now, rules),
    marketCap: noVerifiedMarketCap,
    catalyst: noVerifiedCatalyst
  };
}

function normaliseBinanceSymbol(symbol: string) {
  const normalised = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{5,24}$/.test(normalised)) throw new Error("Invalid Binance symbol.");
  return normalised;
}

function parseLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): BookLevel[] => {
    if (!Array.isArray(row) || row.length < 2) return [];
    const price = Number(row[0]);
    const quantity = Number(row[1]);
    return Number.isFinite(price) && Number.isFinite(quantity) && price > 0 && quantity >= 0 ? [{ price, quantity }] : [];
  });
}

function validQuote(quote: VenueQuote) {
  return quote.price > 0 && Number.isFinite(quote.price) && Number.isFinite(quote.sourceTime)
    && Number.isFinite(quote.receiptTime) && quote.sourceTime <= quote.receiptTime + 60_000;
}

function validCandle(candle: BinanceCandle) {
  return candle.openTime >= 0 && candle.closeTime > candle.openTime && candle.open > 0 && candle.high > 0
    && candle.low > 0 && candle.close > 0 && candle.baseVolume >= 0 && candle.quoteVolume >= 0
    && [candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.baseVolume, candle.quoteVolume].every(Number.isFinite);
}

function validBook(book: OrderBookSnapshot) {
  return book.venue === "Binance" && book.bids.length > 0 && book.asks.length > 0
    && Number.isFinite(book.sourceTime) && Number.isFinite(book.receiptTime)
    && [...book.bids, ...book.asks].every((level) => level.price > 0 && level.quantity >= 0 && Number.isFinite(level.price) && Number.isFinite(level.quantity));
}

function observed<T>(
  value: T,
  source: string,
  sourceTime: number,
  receiptTime: number,
  now: number,
  staleAfterMs: number,
  methodology: string
): Observation<T> {
  const ageMs = Math.max(0, now - sourceTime);
  const state: ObservationState = ageMs > staleAfterMs ? "stale" : "available";
  return {
    state,
    value,
    source,
    sourceTime,
    receiptTime,
    ageMs,
    methodology,
    ...(state === "stale" ? { reason: `The source observation is ${Math.round(ageMs / 1_000)} seconds old.` } : {})
  };
}

function unavailable<T>(source: string, methodology: string, reason: string): Observation<T> {
  return { state: "unavailable", source, methodology, reason };
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quoteDepth(levels: BookLevel[]) {
  return levels.reduce((total, level) => total + level.price * level.quantity, 0);
}

function formatWindow(windowMs: number) {
  if (windowMs % (60 * 60 * 1_000) === 0) return `${windowMs / (60 * 60 * 1_000)}-hour`;
  return `${windowMs / (60 * 1_000)}-minute`;
}
