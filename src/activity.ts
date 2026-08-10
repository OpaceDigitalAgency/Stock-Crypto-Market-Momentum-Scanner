interface ActivityState {
  previousQuoteVolume: number;
  averageDelta: number;
  samples: number;
}

export class SessionActivityTracker {
  private readonly states = new Map<string, ActivityState>();

  observe(symbol: string, quoteVolume: number) {
    const previous = this.states.get(symbol);
    if (!previous || quoteVolume < previous.previousQuoteVolume) {
      this.states.set(symbol, { previousQuoteVolume: quoteVolume, averageDelta: 0, samples: 0 });
      return { ratio: 1, measured: false };
    }

    const delta = Math.max(0, quoteVolume - previous.previousQuoteVolume);
    const ratio = previous.samples >= 3 && previous.averageDelta > 0
      ? Math.min(20, delta / previous.averageDelta)
      : 1;
    const averageDelta = previous.samples === 0
      ? delta
      : previous.averageDelta * 0.85 + delta * 0.15;

    this.states.set(symbol, {
      previousQuoteVolume: quoteVolume,
      averageDelta,
      samples: previous.samples + 1
    });

    return { ratio: Number.isFinite(ratio) ? ratio : 1, measured: previous.samples >= 3 };
  }
}

export function coinbaseProductFor(binanceSymbol: string) {
  if (!binanceSymbol.endsWith("USDT")) return undefined;
  const base = binanceSymbol.slice(0, -4);
  if (!base || isStableQuoteBase(base) || isLeveragedToken(base)) return undefined;
  return `${base}-USD`;
}

export function isCrossVenueConfirmed(binancePrice: number, coinbasePrice?: number, maximumDifferencePercent = 1) {
  if (!coinbasePrice || binancePrice <= 0 || coinbasePrice <= 0) return false;
  return Math.abs(binancePrice - coinbasePrice) / binancePrice * 100 <= maximumDifferencePercent;
}

export function isStableQuoteBase(base: string) {
  return ["USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "EURC", "GBP", "TRY", "BRL"].includes(base);
}

export function isLeveragedToken(base: string) {
  return /(?:UP|DOWN|BULL|BEAR)$/.test(base);
}
