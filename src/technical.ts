export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PullbackAnalysis {
  ready: true;
  retracementPercent: number;
  greenVolumeDominant: boolean;
  aboveVwap: boolean;
  aboveEma9: boolean;
  toppingTail: boolean;
  breakingHigher: boolean;
  vwap: number;
  ema9: number;
  pullbackLow: number;
  verdict: "entry" | "wait" | "avoid";
}

export interface PullbackUnavailable {
  ready: false;
  reason: string;
}

export type PullbackResult = PullbackAnalysis | PullbackUnavailable;

export function vwapOf(candles: Candle[]): number {
  let priceVolume = 0;
  let totalVolume = 0;
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    priceVolume += typical * candle.volume;
    totalVolume += candle.volume;
  }
  return totalVolume > 0 ? priceVolume / totalVolume : candles.at(-1)?.close ?? 0;
}

export function emaOf(closes: number[], period: number): number {
  if (!closes.length) return 0;
  const multiplier = 2 / (period + 1);
  let ema = closes[0];
  for (let index = 1; index < closes.length; index += 1) {
    ema = (closes[index] - ema) * multiplier + ema;
  }
  return ema;
}

const LOOKBACK = 45;
const VOLUME_WINDOW = 12;

export function analysePullback(allCandles: Candle[]): PullbackResult {
  const candles = allCandles.filter((candle) => candle.volume > 0 || candle.high !== candle.low);
  if (candles.length < 12) return { ready: false, reason: "not-enough-candles" };

  const recent = candles.slice(-LOOKBACK);
  const closes = candles.map((candle) => candle.close);
  const last = recent[recent.length - 1];
  const previous = recent[recent.length - 2];

  const vwap = vwapOf(candles);
  const ema9 = emaOf(closes, 9);

  // Find the leg up: highest high in the window, then the lowest low before it.
  let highIndex = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index].high >= recent[highIndex].high) highIndex = index;
  }
  const legHigh = recent[highIndex].high;
  let legLow = recent[0].low;
  for (let index = 0; index <= highIndex; index += 1) {
    if (recent[index].low < legLow) legLow = recent[index].low;
  }
  const legRange = legHigh - legLow;
  if (legRange <= 0) return { ready: false, reason: "no-clear-move" };

  // The pullback low is the lowest point after the leg high (or the high itself if nothing followed).
  let pullbackLow = legHigh;
  for (let index = highIndex + 1; index < recent.length; index += 1) {
    if (recent[index].low < pullbackLow) pullbackLow = recent[index].low;
  }
  const retracementPercent = highIndex === recent.length - 1 ? 0 : ((legHigh - pullbackLow) / legRange) * 100;

  // Volume behaviour over the recent window: green candles should carry more volume than red ones.
  const window = recent.slice(-VOLUME_WINDOW);
  let greenVolume = 0;
  let redVolume = 0;
  for (const candle of window) {
    if (candle.close >= candle.open) greenVolume += candle.volume;
    else redVolume += candle.volume;
  }
  const greenVolumeDominant = greenVolume >= redVolume;

  // Topping tail on the most recent completed candle: a long upper wick that dwarfs the body.
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const range = last.high - last.low;
  const toppingTail = range > 0 && upperWick > range * 0.5 && upperWick > body;

  const aboveVwap = last.close >= vwap;
  const aboveEma9 = last.close >= ema9;
  const breakingHigher = previous !== undefined && last.high > previous.high && last.close >= last.open;

  const structureSound = retracementPercent <= 50 && aboveVwap && aboveEma9 && !toppingTail;
  const verdict: PullbackAnalysis["verdict"] = structureSound && breakingHigher && greenVolumeDominant
    ? "entry"
    : retracementPercent > 50 || (!aboveVwap && !aboveEma9)
      ? "avoid"
      : "wait";

  return {
    ready: true,
    retracementPercent,
    greenVolumeDominant,
    aboveVwap,
    aboveEma9,
    toppingTail,
    breakingHigher,
    vwap,
    ema9,
    pullbackLow,
    verdict
  };
}
