import { emaOf, vwapOf, type Candle } from "./technical";

export interface ChartOptions {
  precision: "full" | "price-only";
  showGuides: boolean;
  markPrice?: number;
  markStop?: number;
}

const WIDTH = 820;
const HEIGHT = 260;
const PAD_X = 8;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;

function esc(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function formatPrice(value: number) {
  return value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toPrecision(3);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Renders the trading day as an inline SVG: candlesticks when full OHLCV data
 * is available, a smooth line when only price points exist. VWAP and 9 EMA
 * guides are drawn when requested and meaningful.
 */
export function renderDayChart(allCandles: Candle[], options: ChartOptions): string {
  const candles = allCandles.slice(-120).filter((candle) => candle.high > 0);
  if (candles.length < 5) {
    return `<div class="chart-empty">Not enough price history to draw the day yet.</div>`;
  }
  const priceOnly = options.precision === "price-only";
  let min = Infinity;
  let max = -Infinity;
  for (const candle of candles) {
    min = Math.min(min, candle.low);
    max = Math.max(max, candle.high);
  }
  if (options.markStop !== undefined) min = Math.min(min, options.markStop);
  if (options.markPrice !== undefined) {
    min = Math.min(min, options.markPrice);
    max = Math.max(max, options.markPrice);
  }
  const range = max - min || max * 0.01 || 1;
  min -= range * 0.05;
  max += range * 0.05;

  const innerWidth = WIDTH - PAD_X * 2;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const x = (index: number) => PAD_X + (index + 0.5) * (innerWidth / candles.length);
  const y = (price: number) => PAD_TOP + (1 - (price - min) / (max - min)) * innerHeight;
  const slot = innerWidth / candles.length;
  const bodyWidth = Math.max(1.5, Math.min(9, slot * 0.62));

  const parts: string[] = [];

  // Horizontal reference lines with price labels.
  for (const fraction of [0.25, 0.5, 0.75]) {
    const price = min + (max - min) * fraction;
    const lineY = y(price);
    parts.push(`<line x1="${PAD_X}" y1="${lineY}" x2="${WIDTH - PAD_X}" y2="${lineY}" class="chart-grid"/>`);
    parts.push(`<text x="${WIDTH - PAD_X - 4}" y="${lineY - 4}" class="chart-axis" text-anchor="end">${formatPrice(price)}</text>`);
  }

  if (priceOnly) {
    const points = candles.map((candle, index) => `${x(index).toFixed(1)},${y(candle.close).toFixed(1)}`).join(" ");
    const rising = candles[candles.length - 1].close >= candles[0].close;
    parts.push(`<polyline points="${points}" class="chart-line ${rising ? "up" : "down"}"/>`);
  } else {
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      const up = candle.close >= candle.open;
      const cx = x(index);
      const bodyTop = y(Math.max(candle.open, candle.close));
      const bodyBottom = y(Math.min(candle.open, candle.close));
      parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(candle.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(candle.low).toFixed(1)}" class="candle-wick ${up ? "up" : "down"}"/>`);
      parts.push(`<rect x="${(cx - bodyWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${Math.max(1, bodyBottom - bodyTop).toFixed(1)}" class="candle-body ${up ? "up" : "down"}" rx="1"/>`);
    }
  }

  if (options.showGuides && !priceOnly) {
    const vwapSeries: string[] = [];
    const emaSeries: string[] = [];
    for (let index = 4; index < candles.length; index += 1) {
      const upTo = candles.slice(0, index + 1);
      vwapSeries.push(`${x(index).toFixed(1)},${y(vwapOf(upTo)).toFixed(1)}`);
      emaSeries.push(`${x(index).toFixed(1)},${y(emaOf(upTo.map((candle) => candle.close), 9)).toFixed(1)}`);
    }
    parts.push(`<polyline points="${vwapSeries.join(" ")}" class="chart-vwap"/>`);
    parts.push(`<polyline points="${emaSeries.join(" ")}" class="chart-ema"/>`);
  }

  if (options.markStop !== undefined && options.markStop > min && options.markStop < max) {
    const stopY = y(options.markStop);
    parts.push(`<line x1="${PAD_X}" y1="${stopY}" x2="${WIDTH - PAD_X}" y2="${stopY}" class="chart-stop"/>`);
    parts.push(`<text x="${PAD_X + 4}" y="${stopY - 4}" class="chart-axis stop">get-out ${formatPrice(options.markStop)}</text>`);
  }

  const last = candles[candles.length - 1];
  parts.push(`<circle cx="${x(candles.length - 1).toFixed(1)}" cy="${y(last.close).toFixed(1)}" r="3" class="chart-last"/>`);

  const firstLabel = formatTime(candles[0].time);
  const lastLabel = formatTime(last.time);
  parts.push(`<text x="${PAD_X}" y="${HEIGHT - 8}" class="chart-axis">${esc(firstLabel)}</text>`);
  parts.push(`<text x="${WIDTH - PAD_X}" y="${HEIGHT - 8}" class="chart-axis" text-anchor="end">${esc(lastLabel)}</text>`);

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" class="day-chart" role="img" aria-label="Price chart of the day" preserveAspectRatio="none">${parts.join("")}</svg>`;
}
