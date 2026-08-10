import "./styles.css";
import { coinbaseProductFor, isCrossVenueConfirmed } from "./activity";
import { BinanceFeed } from "./binance-feed";
import { CoinbaseFeed } from "./coinbase-feed";
import type { CatalystReport } from "./catalyst-types";
import { BINANCE_PUBLIC_REST_ENDPOINT, buildBinanceKlinesUrl, buildCryptoMarketSnapshot, parseBinanceKlines, parseBinancePartialBook, type CryptoMarketSnapshot } from "./crypto-market-data";
import { calculatePlan, defaultFilters, matchesFilters, scoreCandidate } from "./engine";
import { fetchCandles, mapStockQuote, StocksFeed, type StocksStatus } from "./stocks-feed";
import { JournalStore } from "./storage";
import { renderDayChart } from "./chart";
import { analysePullback, type Candle, type PullbackResult } from "./technical";
import type { AssetClass, Candidate, Filters, JournalEntry } from "./types";

type View = "discover" | "plan" | "journal" | "how";
type Mode = "simple" | "advanced";

interface Prefs {
  mode: Mode;
  defaultRisk: number;
  dailyLossLimit: number;
  chime: boolean;
}

const PREFS_KEY = "pulseboard-prefs-v1";
const NO_TRADE_KEY = "pulseboard-no-trade-days-v1";

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      mode: raw.mode === "advanced" ? "advanced" : "simple",
      defaultRisk: typeof raw.defaultRisk === "number" && raw.defaultRisk > 0 ? raw.defaultRisk : 50,
      dailyLossLimit: typeof raw.dailyLossLimit === "number" && raw.dailyLossLimit > 0 ? raw.dailyLossLimit : 150,
      chime: raw.chime === true
    };
  } catch {
    return { mode: "simple", defaultRisk: 50, dailyLossLimit: 150, chime: false };
  }
}

function loadNoTradeDays(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NO_TRADE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

interface SessionInfo {
  clock: string;
  phase: "pre-market" | "open" | "after-hours" | "closed";
  phaseLabel: string;
  prime: boolean;
  trackPercent: number;
  primeStartPercent: number;
  primeEndPercent: number;
}

function newYorkSession(now = new Date()): SessionInfo {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekday = get("weekday");
  const minutes = hour * 60 + minute;
  const weekend = weekday === "Sat" || weekday === "Sun";
  const phase: SessionInfo["phase"] = weekend ? "closed"
    : minutes >= 240 && minutes < 570 ? "pre-market"
    : minutes >= 570 && minutes < 960 ? "open"
    : minutes >= 960 && minutes < 1200 ? "after-hours"
    : "closed";
  const phaseLabel = phase === "pre-market" ? "Pre-market" : phase === "open" ? "Market open" : phase === "after-hours" ? "After hours" : "Market closed";
  const trackStart = 240;
  const trackEnd = 1200;
  const clampTrack = (value: number) => Math.min(100, Math.max(0, ((value - trackStart) / (trackEnd - trackStart)) * 100));
  return {
    clock: `${get("hour")}:${get("minute")}`,
    phase,
    phaseLabel,
    prime: !weekend && minutes >= 420 && minutes < 600,
    trackPercent: clampTrack(minutes),
    primeStartPercent: clampTrack(420),
    primeEndPercent: clampTrack(600)
  };
}

interface Tick {
  label: string;
  detail: string;
  state: "pass" | "fail" | "unknown";
}

class App {
  private assetClass: AssetClass = "stocks";
  private view: View = "discover";
  private prefs = loadPrefs();
  private selected?: Candidate;
  private filters: Record<AssetClass, Filters> = structuredClone(defaultFilters);
  private journalStore = new JournalStore();
  private journal = this.journalStore.load();
  private noTradeDays = loadNoTradeDays();

  private stocksFeed?: StocksFeed;
  private stocksStatus: StocksStatus = "loading";
  private stocksDetail = "";
  private stockCandidates: Candidate[] = [];

  private feed?: BinanceFeed;
  private coinbaseFeed?: CoinbaseFeed;
  private coinbasePrices = new Map<string, { price: number; receiptTime: number }>();
  private cryptoDetails = new Map<string, CryptoMarketSnapshot>();
  private cryptoDetailPending = new Set<string>();
  private cryptoDetailFailures = new Set<string>();
  private cryptoCandidates: Candidate[] = [];
  private cryptoStatus = "connecting";
  private coinbaseStatus = "idle";

  private catalystReports = new Map<string, CatalystReport>();
  private catalystsRequested = new Set<string>();

  private pullbacks = new Map<string, { result: PullbackResult; at: number; precision: "full" | "price-only"; candles: Candle[] }>();
  private cryptoNews = new Map<string, { news: { count: number; url?: string; title?: string; publisher?: string; kind?: string } | null; at: number }>();
  private cryptoNewsPending = new Set<string>();
  private pullbackPending = new Set<string>();

  private pendingDeleteId?: string;
  private knownQualifiers = new Set<string>();
  private audio?: AudioContext;

  constructor(private readonly root: HTMLElement) {
    this.render();
    this.startStocks();
    this.startCrypto();
    window.setInterval(() => this.refreshSessionStrip(), 30_000);
  }

  private get simple() {
    return this.prefs.mode === "simple";
  }

  private savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
  }

  /* ---------- Data: stocks ---------- */

  private startStocks() {
    this.stocksFeed = new StocksFeed(
      (quotes) => {
        const receiptTime = Date.now();
        this.stockCandidates = quotes.map((quote) => {
          const base = mapStockQuote(quote, receiptTime);
          const report = this.catalystReports.get(base.symbol);
          const withCatalyst = report
            ? { ...base, ...this.catalystFields(report) }
            : { ...base, catalystState: "checking" as const };
          return { ...withCatalyst, score: scoreCandidate(withCatalyst, this.filters.stocks) };
        });
        this.maybeChime(this.stockCandidates, "stocks");
        void this.lookupStockCatalysts();
        if (this.assetClass === "stocks") this.refreshDiscoverData();
      },
      (status, detail) => {
        this.stocksStatus = status;
        this.stocksDetail = detail ?? "";
        if (this.assetClass === "stocks") this.refreshDiscoverData();
      }
    );
    this.stocksFeed.start();
  }

  private async lookupStockCatalysts() {
    const targets = this.rankedCandidates("stocks").slice(0, 8).map((candidate) => candidate.symbol)
      .filter((symbol) => !this.catalystsRequested.has(symbol));
    if (!targets.length) return;
    targets.forEach((symbol) => this.catalystsRequested.add(symbol));
    try {
      const response = await fetch("/.netlify/functions/catalysts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: targets, lookbackDays: 3 })
      });
      if (!response.ok) throw new Error("Catalyst service unavailable");
      const payload = await response.json() as { reports?: CatalystReport[] };
      for (const report of payload.reports ?? []) this.catalystReports.set(report.symbol, report);
      this.stockCandidates = this.stockCandidates.map((candidate) => {
        const report = this.catalystReports.get(candidate.symbol);
        if (!report) return candidate;
        const enriched = { ...candidate, ...this.catalystFields(report) };
        return { ...enriched, score: scoreCandidate(enriched, this.filters.stocks) };
      });
    } catch {
      this.stockCandidates = this.stockCandidates.map((candidate) => candidate.catalystState === "checking" ? { ...candidate, catalystState: "source-unavailable" as const } : candidate);
    }
    if (this.assetClass === "stocks") this.refreshDiscoverData();
  }

  private catalystFields(report: CatalystReport) {
    const news = report.news && report.news.count > 0
      ? { count: report.news.count, url: report.news.topUrl, title: report.news.topTitle, publisher: report.news.publisher, kind: report.news.kind }
      : undefined;
    const catalyst = report.state === "confirmed" ? "confirmed" as const
      : news ? "unverified" as const
      : "none" as const;
    return { catalyst, catalystState: report.state, catalystEvidence: report.evidence, catalystNews: news };
  }

  /* ---------- Data: crypto ---------- */

  private startCrypto() {
    this.feed = new BinanceFeed(
      () => this.filters.crypto,
      (candidates) => {
        if (!this.coinbaseFeed) this.startCoinbaseConfirmation(candidates);
        const incoming = this.applyCryptoDetails(this.applyCrossVenue(candidates));
        const incomingSymbols = new Set(incoming.map((candidate) => candidate.symbol));
        const retained = this.cryptoCandidates.filter((candidate) => !incomingSymbols.has(candidate.symbol) && Date.now() - candidate.receiptTime <= 60_000);
        this.cryptoCandidates = [...incoming, ...retained];
        this.maybeChime(this.cryptoCandidates, "crypto");
        void this.enrichCryptoDetails(candidates);
        void this.enrichCryptoNews();
        if (this.assetClass === "crypto") this.refreshDiscoverData();
      },
      (status) => {
        this.cryptoStatus = status;
        if (this.assetClass === "crypto") this.refreshDiscoverData();
      },
      () => {
        // Coverage counts are not surfaced in this UI.
      }
    );
    this.feed.connect();
  }

  private startCoinbaseConfirmation(candidates: Candidate[]) {
    const productIds = [...new Set([
      "BTC-USD", "ETH-USD", "SOL-USD",
      ...candidates.map((candidate) => coinbaseProductFor(candidate.symbol)).filter((value): value is string => Boolean(value))
    ])].slice(0, 50);
    this.coinbaseFeed = new CoinbaseFeed(
      productIds,
      (prices) => {
        const receiptTime = Date.now();
        prices.forEach((price, product) => {
          if (Number.isFinite(price)) this.coinbasePrices.set(product, { price, receiptTime });
          else this.coinbasePrices.delete(product);
        });
        this.cryptoCandidates = this.applyCrossVenue(this.cryptoCandidates);
        if (this.assetClass === "crypto") this.refreshDiscoverData();
      },
      (status) => {
        this.coinbaseStatus = status;
        if (status !== "live") {
          this.coinbasePrices.clear();
          this.cryptoCandidates = this.applyCrossVenue(this.cryptoCandidates);
        }
        if (this.assetClass === "crypto") this.refreshDiscoverData();
      }
    );
    this.coinbaseFeed.connect();
  }

  private applyCrossVenue(candidates: Candidate[]) {
    return candidates.map((candidate) => {
      const product = coinbaseProductFor(candidate.symbol);
      const coinbase = product ? this.coinbasePrices.get(product) : undefined;
      const confirmed = this.coinbaseStatus === "live" && isCrossVenueConfirmed(candidate.price, coinbase?.price);
      const enriched = { ...candidate, crossVenue: confirmed, coverage: confirmed ? "cross-venue-checked" as const : "single-venue" as const, venue: confirmed ? "Binance + Coinbase" : "Binance" };
      return { ...enriched, score: scoreCandidate(enriched, this.filters.crypto) };
    });
  }

  private async enrichCryptoNews() {
    const targets = this.rankedCandidates("crypto").slice(0, 8).filter((candidate) => {
      const cached = this.cryptoNews.get(candidate.symbol);
      return !this.cryptoNewsPending.has(candidate.symbol) && (!cached || Date.now() - cached.at > 10 * 60_000);
    });
    await Promise.all(targets.map(async (candidate) => {
      this.cryptoNewsPending.add(candidate.symbol);
      try {
        const base = this.displaySymbol(candidate);
        const response = await fetch(`/api/news?q=${encodeURIComponent(`${base} crypto`)}`);
        if (!response.ok) throw new Error("News source unavailable");
        const payload = await response.json() as { count?: number; topTitle?: string; topUrl?: string; publisher?: string; kind?: string };
        this.cryptoNews.set(candidate.symbol, {
          news: payload.count && payload.count > 0 ? { count: payload.count, title: payload.topTitle, url: payload.topUrl, publisher: payload.publisher, kind: payload.kind } : null,
          at: Date.now()
        });
      } catch {
        this.cryptoNews.set(candidate.symbol, { news: null, at: Date.now() });
      } finally {
        this.cryptoNewsPending.delete(candidate.symbol);
      }
    }));
    if (targets.length) {
      this.cryptoCandidates = this.applyCryptoDetails(this.cryptoCandidates);
      if (this.assetClass === "crypto") this.refreshDiscoverData();
    }
  }

  private applyCryptoDetails(candidates: Candidate[]) {
    return candidates.map((candidate) => {
      const detail = this.cryptoDetails.get(candidate.symbol);
      const momentum5m = detail?.momentum.fiveMinutes.value?.percent ?? null;
      const momentum1h = detail?.momentum.oneHour.value?.percent ?? null;
      const depthQuote = detail?.liquidity.value?.minimumSideDepthQuote ?? null;
      const spreadPercent = detail?.liquidity.value?.spreadPercent ?? candidate.spreadPercent;
      const relativeVolume = detail?.activity.value?.ratio ?? candidate.relativeVolume;
      const detailState = detail ? "available" as const
        : this.cryptoDetailFailures.has(candidate.symbol) ? "unavailable" as const
        : this.cryptoDetailPending.has(candidate.symbol) ? "loading" as const
        : "queued" as const;
      const newsRecord = this.cryptoNews.get(candidate.symbol);
      const catalystNews = newsRecord?.news ?? undefined;
      const enriched = {
        ...candidate,
        momentum5m,
        momentum1h,
        depthQuote,
        spreadPercent,
        relativeVolume,
        detailState,
        catalystNews,
        catalyst: catalystNews ? "unverified" as const : candidate.catalyst
      };
      return { ...enriched, score: scoreCandidate(enriched, this.filters.crypto) };
    });
  }

  private async enrichCryptoDetails(candidates: Candidate[]) {
    const selected = candidates.slice(0, 20).filter((candidate) => {
      const existing = this.cryptoDetails.get(candidate.symbol);
      return !this.cryptoDetailPending.has(candidate.symbol) && (!existing || Date.now() - existing.asOf > 60_000);
    });
    await Promise.all(selected.map(async (candidate) => {
      this.cryptoDetailPending.add(candidate.symbol);
      this.cryptoDetailFailures.delete(candidate.symbol);
      try {
        const now = Date.now();
        const [klinesResponse, depthResponse] = await Promise.all([
          fetch(buildBinanceKlinesUrl(candidate.symbol, 300)),
          fetch(`${BINANCE_PUBLIC_REST_ENDPOINT}/api/v3/depth?symbol=${encodeURIComponent(candidate.symbol)}&limit=20`)
        ]);
        if (!klinesResponse.ok || !depthResponse.ok) throw new Error("Binance detail request failed");
        const [klinesPayload, depthPayload] = await Promise.all([klinesResponse.json(), depthResponse.json()]);
        const product = coinbaseProductFor(candidate.symbol);
        const coinbase = product ? this.coinbasePrices.get(product) : undefined;
        const detail = buildCryptoMarketSnapshot({
          symbol: candidate.symbol,
          now,
          candles: parseBinanceKlines(klinesPayload),
          binanceQuote: { venue: "Binance", pair: candidate.symbol, price: candidate.price, sourceTime: candidate.sourceTime, receiptTime: candidate.receiptTime },
          coinbaseQuote: coinbase && product ? { venue: "Coinbase", pair: product, price: coinbase.price, sourceTime: coinbase.receiptTime, receiptTime: coinbase.receiptTime } : undefined,
          binanceBook: parseBinancePartialBook(depthPayload, candidate.symbol, now, Date.now())
        });
        this.cryptoDetails.set(candidate.symbol, detail);
      } catch {
        this.cryptoDetailFailures.add(candidate.symbol);
      } finally {
        this.cryptoDetailPending.delete(candidate.symbol);
      }
    }));
    this.cryptoCandidates = this.applyCryptoDetails(this.cryptoCandidates);
    if (this.assetClass === "crypto") this.refreshDiscoverData();
  }

  /* ---------- Data: pullback analysis ---------- */

  private async ensurePullback(candidate: Candidate) {
    const cached = this.pullbacks.get(candidate.symbol);
    if (cached && Date.now() - cached.at < 60_000) return;
    if (this.pullbackPending.has(candidate.symbol)) return;
    this.pullbackPending.add(candidate.symbol);
    try {
      let candles: Candle[] = [];
      let precision: "full" | "price-only" = "full";
      if (candidate.assetClass === "stocks") {
        const payload = await fetchCandles(candidate.symbol);
        candles = payload.candles;
        precision = payload.precision === "price-only" ? "price-only" : "full";
      } else {
        const response = await fetch(`${BINANCE_PUBLIC_REST_ENDPOINT}/api/v3/klines?symbol=${encodeURIComponent(candidate.symbol)}&interval=1m&limit=120`);
        if (!response.ok) throw new Error("Binance klines unavailable");
        candles = parseBinanceKlines(await response.json()).map((raw) => ({
          time: raw.closeTime, open: raw.open, high: raw.high, low: raw.low, close: raw.close, volume: raw.baseVolume
        }));
      }
      this.pullbacks.set(candidate.symbol, { result: analysePullback(candles), at: Date.now(), precision, candles });
    } catch {
      this.pullbacks.set(candidate.symbol, { result: { ready: false, reason: "source-unavailable" }, at: Date.now(), precision: "full", candles: [] });
    } finally {
      this.pullbackPending.delete(candidate.symbol);
      if (this.view === "plan" && this.selected?.symbol === candidate.symbol) this.render();
      else if (this.view === "discover") this.refreshCandidateResults();
    }
  }

  /* ---------- Verdicts ---------- */

  private momentVerdict(candidate: Candidate): "entry" | "wait" | "avoid" | undefined {
    const record = this.pullbacks.get(candidate.symbol);
    return record?.result.ready ? record.result.verdict : undefined;
  }

  private overallVerdict(candidate: Candidate, ticks: Tick[]) {
    const passes = ticks.filter((tick) => tick.state === "pass").length;
    const strong = passes >= 4;
    const weak = passes <= 2;
    const moment = this.momentVerdict(candidate);
    if (weak) return { cls: "skip", label: this.simple ? "Probably skip" : "Weak", passes };
    if (!strong) return { cls: "mid", label: this.simple ? "Borderline" : "Borderline", passes };
    if (moment === "entry") return { cls: "go", label: this.simple ? "Worth a look now" : "Strong · entry signal", passes };
    if (moment === "wait") return { cls: "hold", label: this.simple ? "Strong — not yet" : "Strong · wait", passes };
    if (moment === "avoid") return { cls: "off", label: this.simple ? "Strong — pattern broke" : "Strong · pattern failed", passes };
    return { cls: "strong", label: this.simple ? "Strong — checking the moment…" : "Strong · moment unchecked", passes };
  }

  private companyTip(candidate: Candidate) {
    if (candidate.assetClass === "crypto") {
      const base = this.displaySymbol(candidate);
      return `${base} is the coin being traded. USDT (Tether, a dollar-tracking token) is the currency used to price it on Binance. This row describes the ${base}/USDT trading pair, not the whole project.`;
    }
    const business = candidate.sector ? ` — ${candidate.sector}${candidate.industry ? ` · ${candidate.industry}` : ""}` : "";
    return `${candidate.name}${business}. Listed on ${candidate.venue || "a US exchange"}.`;
  }

  /* ---------- Chime ---------- */

  private maybeChime(candidates: Candidate[], assetClass: AssetClass) {
    if (!this.prefs.chime) return;
    const filters = this.filters[assetClass];
    for (const candidate of candidates) {
      const key = `${assetClass}:${candidate.symbol}`;
      if (matchesFilters(candidate, filters) && !this.knownQualifiers.has(key)) {
        this.knownQualifiers.add(key);
        this.beep();
      }
    }
  }

  private beep() {
    try {
      this.audio ??= new AudioContext();
      const oscillator = this.audio.createOscillator();
      const gain = this.audio.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.06, this.audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.audio.currentTime + 0.25);
      oscillator.connect(gain).connect(this.audio.destination);
      oscillator.start();
      oscillator.stop(this.audio.currentTime + 0.25);
    } catch {
      // Audio is optional; never let it break the app.
    }
  }

  /* ---------- Candidate ranking & ticks ---------- */

  private rankedCandidates(assetClass: AssetClass = this.assetClass) {
    const source = assetClass === "stocks" ? this.stockCandidates : this.cryptoCandidates;
    return [...source].sort((a, b) => b.score - a.score || b.changePercent - a.changePercent);
  }

  private ticksFor(candidate: Candidate): Tick[] {
    const filters = this.filters[candidate.assetClass];
    if (candidate.assetClass === "stocks") {
      const priceOk = candidate.price >= filters.minPrice && candidate.price <= filters.maxPrice;
      const gainOk = candidate.changePercent >= filters.minChange;
      const rvolKnown = candidate.relativeVolume > 0;
      const rvolOk = candidate.relativeVolume >= filters.minRelativeVolume;
      const sharesKnown = candidate.floatOrMarketCap !== null;
      const sharesOk = sharesKnown && (candidate.floatOrMarketCap as number) <= filters.maxFloatMillions;
      const catalystChecked = candidate.catalystState === "confirmed" || candidate.catalystState === "no-evidence";
      return [
        { label: this.simple ? "Up a lot today" : `Gain ≥ ${filters.minChange}%`, detail: `${this.percent(candidate.changePercent)} so far`, state: gainOk ? "pass" : "fail" },
        { label: this.simple ? "Much busier than normal" : `Relative volume ≥ ${filters.minRelativeVolume}×`, detail: rvolKnown ? `${candidate.relativeVolume.toFixed(1)}× its usual trading` : "Usual volume unknown", state: !rvolKnown ? "unknown" : rvolOk ? "pass" : "fail" },
        { label: this.simple ? "In your price range" : `Price $${filters.minPrice}–$${filters.maxPrice}`, detail: this.money(candidate.price), state: priceOk ? "pass" : "fail" },
        { label: this.simple ? "Only a small number of shares exist" : `Shares in issue ≤ ${filters.maxFloatMillions}m`, detail: sharesKnown ? `${(candidate.floatOrMarketCap as number).toFixed(0)}m shares in issue` : "Share count unknown", state: !sharesKnown ? "unknown" : sharesOk ? "pass" : "fail" },
        this.catalystTick(candidate, catalystChecked)
      ];
    }
    return this.cryptoTicks(candidate, filters);
  }

  private catalystTick(candidate: Candidate, catalystChecked: boolean): Tick {
    const label = this.simple ? "Clear reason for the move" : "Catalyst";
    if (candidate.catalystState === "confirmed") {
      const evidence = candidate.catalystEvidence?.[0];
      const what = evidence?.title ? this.truncate(evidence.title, 72) : "official filing or trading halt";
      return { label, detail: `Official: ${what}`, state: "pass" };
    }
    const news = candidate.catalystNews;
    if (news) {
      if (news.kind === "Market roundup") {
        return { label, detail: this.simple ? "No headline names it directly — only broad market coverage found" : "No subject-specific headline; broad coverage only", state: "unknown" };
      }
      const headline = news.title ? `“${this.truncate(news.title, 84)}”` : `${news.count} recent stories`;
      const prefix = news.kind ?? "In the news";
      return { label, detail: `${prefix} — ${headline}`, state: "pass" };
    }
    if (candidate.assetClass === "crypto") {
      const cached = this.cryptoNews.get(candidate.symbol);
      if (cached && cached.news === null) {
        return { label, detail: this.simple ? "No clear news found — crypto spikes often start on social media before the press" : "No recent headlines found", state: "unknown" };
      }
      return { label, detail: "Checking the news…", state: "unknown" };
    }
    if (!catalystChecked) return { label, detail: "Not checked yet", state: "unknown" };
    return { label, detail: "No official news or headlines found", state: "fail" };
  }

  private truncate(value: string, length: number) {
    return value.length > length ? `${value.slice(0, length - 1).trimEnd()}…` : value;
  }

  private cryptoTicks(candidate: Candidate, filters: Filters): Tick[] {
    const momentumKnown = candidate.momentum5m !== null && candidate.momentum5m !== undefined;
    const movingNow = momentumKnown && ((candidate.momentum5m ?? 0) > 0 || (candidate.momentum1h ?? 0) > 0);
    const busy = candidate.relativeVolume >= Math.max(filters.minRelativeVolume, 1.2);
    const tradeable = candidate.spreadPercent <= filters.maxSpreadPercent && candidate.volume >= filters.minQuoteVolumeMillions * 1_000_000;
    return [
      { label: this.simple ? "Up a lot today" : `24h move ≥ ${filters.minChange}%`, detail: `${this.percent(candidate.changePercent)} in 24 hours`, state: candidate.changePercent >= filters.minChange ? "pass" : "fail" },
      { label: this.simple ? "Moving right now" : "Positive 5m/1h momentum", detail: momentumKnown ? `${this.percent(candidate.momentum5m ?? 0)} in 5 min · ${this.percent(candidate.momentum1h ?? 0)} in 1 hour` : "Still measuring", state: !momentumKnown ? "unknown" : movingNow ? "pass" : "fail" },
      { label: this.simple ? "Busier than usual" : "5m activity above recent norm", detail: `${candidate.relativeVolume.toFixed(1)}× its recent activity`, state: busy ? "pass" : "fail" },
      { label: this.simple ? "Easy to buy and sell" : "Spread and volume within limits", detail: `${candidate.spreadPercent.toFixed(2)}% spread`, state: tradeable ? "pass" : "fail" },
      { label: this.simple ? "Price checked on two venues" : "Coinbase cross-check", detail: candidate.crossVenue ? "Binance and Coinbase agree" : "Binance only", state: candidate.crossVenue ? "pass" : "unknown" },
      this.catalystTick(candidate, true)
    ];
  }

  /* ---------- Render ---------- */

  private render() {
    this.root.innerHTML = `
      ${this.renderTopbar()}
      ${this.renderSessionStrip()}
      <nav class="view-nav" aria-label="Workspace">
        ${(["discover", "plan", "journal", "how"] as View[]).map((view) => `<button data-view="${view}" class="${this.view === view ? "active" : ""}" aria-current="${this.view === view ? "page" : "false"}">${this.viewLabel(view)}</button>`).join("")}
      </nav>
      <main>${this.renderView()}</main>
      <footer><span>Practice only — nothing here is financial advice and no real orders are ever placed.</span><span>Your journal stays in this browser.</span></footer>
    `;
    this.bind();
  }

  private viewLabel(view: View) {
    if (view === "discover") return this.simple ? "What's moving" : "Discover";
    if (view === "plan") return this.simple ? "Check & plan" : "Plan";
    if (view === "journal") return this.simple ? "My results" : "Journal";
    return "How it works";
  }

  private renderTopbar() {
    return `<header class="topbar">
      <a class="brand" href="#"><span class="brand-mark" aria-hidden="true">P</span><span>Pulseboard</span></a>
      <div class="segmented-group" role="group" aria-label="Market">
        <button class="segmented ${this.assetClass === "stocks" ? "active" : ""}" data-asset="stocks" aria-pressed="${this.assetClass === "stocks"}">Stocks</button>
        <button class="segmented ${this.assetClass === "crypto" ? "active" : ""}" data-asset="crypto" aria-pressed="${this.assetClass === "crypto"}">Crypto</button>
      </div>
      <span class="topbar-spacer"></span>
      <div class="segmented-group mode-switch" role="group" aria-label="Detail level">
        <button class="segmented ${this.simple ? "active" : ""}" data-mode="simple" aria-pressed="${this.simple}">Simple</button>
        <button class="segmented ${this.simple ? "" : "active"}" data-mode="advanced" aria-pressed="${!this.simple}">Advanced</button>
      </div>
    </header>`;
  }

  private renderSessionStrip() {
    const session = newYorkSession();
    const status = this.feedStatusLine();
    return `<div class="session-strip" id="session-strip">
      <span class="clock" aria-label="New York time">NY ${session.clock}</span>
      <span class="session-pill ${session.phase === "open" ? "open" : session.phase === "closed" ? "closed" : ""}">${session.phaseLabel}</span>
      ${session.prime ? `<span class="session-pill prime">${this.simple ? "Best hours now" : "Prime window"}</span>` : ""}
      <div class="session-track" aria-hidden="true">
        <span class="prime-zone" style="left:${session.primeStartPercent}%; width:${session.primeEndPercent - session.primeStartPercent}%"></span>
        <span class="now-marker" style="left:${session.trackPercent}%"></span>
      </div>
      <span class="feed-note ${status.live ? "live" : ""}" role="status"><span class="live-dot"></span>${this.escape(status.text)}</span>
    </div>`;
  }

  private refreshSessionStrip() {
    const strip = this.root.querySelector<HTMLElement>("#session-strip");
    if (strip) strip.outerHTML = this.renderSessionStrip();
  }

  private feedStatusLine(): { live: boolean; text: string } {
    if (this.assetClass === "stocks") {
      if (this.stocksStatus === "live") return { live: true, text: this.simple ? "Share prices are flowing" : "Live · US gainers via Yahoo Finance" };
      if (this.stocksStatus === "loading") return { live: false, text: "Loading share prices…" };
      return { live: false, text: this.simple ? "Share prices are unavailable right now" : `Stock source error: ${this.stocksDetail}` };
    }
    if (this.cryptoStatus === "live") {
      return { live: true, text: this.coinbaseStatus === "live" ? (this.simple ? "Crypto prices are flowing" : "Live · Binance + Coinbase check") : (this.simple ? "Crypto prices are flowing" : "Live · Binance only") };
    }
    if (this.cryptoStatus === "connecting") return { live: false, text: "Connecting to crypto prices…" };
    return { live: false, text: this.simple ? "Crypto prices are unavailable right now" : "Binance feed error" };
  }

  private renderView() {
    if (this.view === "plan") return this.renderPlan();
    if (this.view === "journal") return this.renderJournal();
    if (this.view === "how") return this.renderHow();
    return this.renderDiscover();
  }

  private renderHow() {
    return `
      <div class="discover-head">
        <div>
          <p class="eyebrow">The mechanics</p>
          <h1>How this tool works</h1>
          <p class="lede">It finds fast-rising stocks and crypto, checks whether the move looks genuine, then helps you limit your risk. Here is each part in plain English.</p>
        </div>
      </div>
      <div class="how-grid">
        <section class="panel how-card">
          <span class="how-number">1</span>
          <h2>Spot the movers</h2>
          <p>It spots unusual activity by comparing today's trading with what is normally seen, and finds fast risers by measuring how quickly the price has increased.</p>
          <details>
            <summary>What counts as "normal"?</summary>
            <p>For shares, today's trading volume is compared with the stock's recent daily average (roughly the last one to three months, depending on the data source). The strategy this is based on uses five times the 50-day average as its signal; this app uses the closest average its free data provides, and says "usual volume unknown" rather than guessing when none is available.</p>
            <p>For crypto there is no traditional daily session, so this app adapts the idea: each completed five-minute period is compared with the previous twelve, so "normal" continually updates using the last hour. This is an adaptation for 24/7 markets, not a rule from the original stock strategy.</p>
            <p>Speed of rise is measured over three windows for crypto (5 minutes, 1 hour, 24 hours) and as today's percentage gain for shares.</p>
          </details>
        </section>
        <section class="panel how-card">
          <span class="how-number">2</span>
          <h2>Check the move is genuine</h2>
          <p>It checks legitimacy by looking at trading volume, liquidity and genuine company or project news.</p>
          <details>
            <summary>The five checks behind the ticks</summary>
            <p>A strong candidate is up a lot, trading much busier than normal, priced where big percentage moves actually happen, short of supply (few shares in issue — the app uses total shares in issue as its stand-in for tradable float), and moving for a reason you can read — an official filing, a trading halt, or a news headline. Each card shows exactly which of these pass.</p>
            <p>Then the chart shape is read: a genuine move usually rises, takes a small breather without giving back more than half its rise, and starts climbing again. Fakes tend to collapse straight back down.</p>
            <p><strong>These are two separate stages on purpose.</strong> A stock can be a strong candidate all day yet only be buyable for a few minutes of it — so a card can honestly say "strong" while the moment check says "not yet". The card badge combines both.</p>
          </details>
        </section>
        <section class="panel how-card">
          <span class="how-number">3</span>
          <h2>Limit the risk</h2>
          <p>It limits risk by calculating how much to buy and when to exit if the trade falls.</p>
          <details>
            <summary>The rules it applies</summary>
            <p>You choose the most you are willing to lose. The tool sets a get-out price at the low of the breather, sizes the position so a wrong trade costs only that amount, and aims for a win worth at least twice the risk — so being right half the time is enough to come out ahead.</p>
            <p>It also coaches the day itself: stop when you hit your daily limit, stop when you hand back half of a good day, and be wary after the best morning hours are over.</p>
          </details>
        </section>
      </div>
      <section class="panel how-foot">
        <p><strong>Where the data comes from:</strong> live US share prices via public market screens, live crypto prices directly from Binance with a Coinbase cross-check, and reasons from official SEC filings, Nasdaq halt notices and news headlines.</p>
        <p><strong>What this is not:</strong> a prediction machine or financial advice. It is a practice tool — every trade here is simulated, nothing is ever bought or sold, and the aim is to learn a repeatable process before any real money is involved.</p>
      </section>`;
  }

  /* ---------- Discover ---------- */

  private renderDiscover() {
    const filters = this.filters[this.assetClass];
    const heading = this.assetClass === "stocks"
      ? this.simple ? "Shares moving unusually fast" : "US stock gainers, ranked"
      : this.simple ? "Coins moving unusually fast" : "Binance movers, ranked";
    const lede = this.assetClass === "stocks"
      ? this.simple
        ? "These are today's fastest-rising US shares, best first. The ticks show how well each one fits the strategy."
        : "Merged Yahoo Finance gainer screens, scored against the five pillars. Relative volume uses the 3-month average; share count stands in for float."
      : this.simple
        ? "The busiest coins on Binance right now, best first. Prices are checked against Coinbase where possible."
        : "Binance whole-market discovery with 5m/1h momentum, activity versus recent norm, visible depth and a Coinbase price check.";
    return `
      <div class="discover-head">
        <div><p class="eyebrow">${this.simple ? "Right now" : "Momentum discovery"}</p><h1>${heading}</h1><p class="lede">${lede}</p></div>
      </div>
      ${this.renderFilters(filters)}
      <div id="candidate-results">${this.renderCandidates()}</div>
    `;
  }

  private renderFilters(filters: Filters) {
    const stockFields = `
      <label>${this.simple ? "Lowest price" : "Minimum price"}<input id="min-price" type="number" min="0" step="0.5" value="${filters.minPrice}"><span class="unit">$</span></label>
      <label>${this.simple ? "Highest price" : "Maximum price"}<input id="max-price" type="number" min="0" step="0.5" value="${filters.maxPrice}"><span class="unit">$</span></label>
      <label>${this.simple ? "Minimum rise today" : "Minimum gain"}<input id="min-change" type="number" step="1" value="${filters.minChange}"><span class="unit">%</span></label>
      <label>${this.simple ? "How much busier than normal" : "Minimum relative volume"}<input id="min-rvol" type="number" min="0" step="0.5" value="${filters.minRelativeVolume}"><span class="unit">×</span></label>
      ${this.simple ? "" : `<label>Maximum shares in issue<input id="max-float" type="number" min="0" step="1" value="${filters.maxFloatMillions}"><span class="unit">m</span></label>`}
    `;
    const cryptoFields = `
      <label>${this.simple ? "Minimum rise (24h)" : "Minimum 24h move"}<input id="min-change" type="number" step="0.5" value="${filters.minChange}"><span class="unit">%</span></label>
      <label>${this.simple ? "How much busier than usual" : "Minimum 5m activity ratio"}<input id="min-rvol" type="number" min="0" step="0.1" value="${filters.minRelativeVolume}"><span class="unit">×</span></label>
      ${this.simple ? "" : `
      <label>Minimum quote volume<input id="min-volume" type="number" min="0" step="1" value="${filters.minQuoteVolumeMillions}"><span class="unit">$m</span></label>
      <label>Maximum spread<input id="max-spread" type="number" min="0" step="0.1" value="${filters.maxSpreadPercent}"><span class="unit">%</span></label>
      <label>Minimum price<input id="min-price" type="number" min="0" step="0.01" value="${filters.minPrice}"><span class="unit">$</span></label>
      <label>Maximum price<input id="max-price" type="number" min="0" step="1" value="${filters.maxPrice}"><span class="unit">$</span></label>`}
    `;
    return `<details class="filters-disclosure">
      <summary>${this.simple ? "Adjust what counts as interesting" : "Filters"}</summary>
      <div class="filter-grid">
        ${this.assetClass === "stocks" ? stockFields : cryptoFields}
        <label class="check-label"><input id="chime" type="checkbox" ${this.prefs.chime ? "checked" : ""}><span>${this.simple ? "Chime when something strong appears" : "Audio alert on new qualifier"}</span></label>
        <button class="text-button" id="reset-filters" type="button">Reset</button>
        <p class="filter-note">${this.simple ? "The list always shows the strongest movers; these settings decide which ticks they earn." : "Score and pillar ticks are derived from these thresholds. The list ranks by score rather than hiding near-misses."}</p>
      </div>
    </details>`;
  }

  private renderCandidates() {
    const ranked = this.rankedCandidates();
    if (!ranked.length) return this.renderEmpty();
    const rows = ranked.slice(0, this.simple ? 12 : 25);
    return this.simple ? this.renderCards(rows) : this.renderTable(rows);
  }

  private renderEmpty() {
    if (this.assetClass === "stocks") {
      if (this.stocksStatus === "error") {
        return `<div class="empty-state"><strong>Share prices are unavailable right now.</strong><span>The data source did not respond. It usually recovers on its own — the app retries every 30 seconds.</span></div>`;
      }
      return `<div class="empty-state"><strong>Loading today's movers…</strong><span>This normally takes a second or two.</span></div>`;
    }
    if (this.cryptoStatus === "live") {
      return `<div class="empty-state"><strong>Nothing is moving strongly right now.</strong><span>Quiet markets are normal. ${this.simple ? "Skipping is a good decision — you can record it under My results." : "Loosen a filter to inspect weaker movers."}</span></div>`;
    }
    return `<div class="empty-state"><strong>Connecting to live crypto prices…</strong><span>This normally takes a few seconds.</span></div>`;
  }

  private renderCards(rows: Candidate[]) {
    // Judge the moment for the strongest visible cards so the badge can say
    // "worth a look now" versus "not yet" without opening each plan.
    rows.slice(0, 8).forEach((row) => void this.ensurePullback(row));
    return `<div class="card-grid">${rows.map((row) => {
      const ticks = this.ticksFor(row);
      const verdict = this.overallVerdict(row, ticks);
      const moveClass = row.changePercent >= 0 ? "positive" : "negative";
      return `<article class="candidate-card verdict-${verdict.cls}">
        <div class="card-top">
          <div class="card-id">
            <span class="card-symbol">${this.escape(this.displaySymbol(row))}<button class="help-tip" type="button" data-tip="${this.escape(this.companyTip(row))}" aria-label="${this.escape(this.companyTip(row))}">?</button></span>
            <span class="card-name">${this.escape(row.name)}</span>
          </div>
          <div class="card-move-wrap"><span class="card-move ${moveClass}">${this.percent(row.changePercent)}</span><span class="card-price">${this.money(row.price)}</span></div>
        </div>
        <div class="verdict-chip ${verdict.cls}">${this.escape(verdict.label)}</div>
        <div class="tick-row">
          ${ticks.map((tick) => `<span class="tick ${tick.state === "pass" ? "pass" : tick.state === "unknown" ? "unknown" : ""}"><span class="tick-mark">${tick.state === "pass" ? "✓" : tick.state === "unknown" ? "?" : "·"}</span><span>${this.escape(tick.label)} — ${this.escape(tick.detail)}</span></span>`).join("")}
        </div>
        <div class="card-foot">
          <span class="card-meta">${verdict.passes} of ${ticks.length} · ${this.escape(this.dataBadge(row))}</span>
          <button class="row-action" data-symbol="${this.escape(row.symbol)}">${this.simple ? "Check & plan" : "Plan"}</button>
        </div>
      </article>`;
    }).join("")}</div>`;
  }

  private renderTable(rows: Candidate[]) {
    rows.slice(0, 8).forEach((row) => void this.ensurePullback(row));
    const stockHead = `<tr><th>Symbol</th><th>Price</th><th>Move</th><th>RVol</th><th>Volume</th><th>Shares</th><th>Catalyst</th><th>Score</th><th></th></tr>`;
    const cryptoHead = `<tr><th>Pair</th><th>Price</th><th>5m</th><th>1h</th><th>24h</th><th>Activity</th><th>Spread</th><th>Venues</th><th>Score</th><th></th></tr>`;
    return `<div class="table-wrap"><table>
      <thead>${this.assetClass === "stocks" ? stockHead : cryptoHead}</thead>
      <tbody>${rows.map((row) => this.assetClass === "stocks" ? this.renderStockRow(row) : this.renderCryptoRow(row)).join("")}</tbody>
    </table></div>`;
  }

  private renderStockRow(row: Candidate) {
    const moveClass = row.changePercent >= 0 ? "positive" : "negative";
    const news = row.catalystNews
      ? row.catalystNews.url && this.safeUrl(row.catalystNews.url)
        ? `<a class="text-button" href="${this.escape(row.catalystNews.url)}" target="_blank" rel="noopener noreferrer">News (${row.catalystNews.count})</a><small>${this.escape(row.catalystNews.publisher ?? "reported")}</small>`
        : `News (${row.catalystNews.count})<small>${this.escape(row.catalystNews.publisher ?? "reported")}</small>`
      : null;
    const catalyst = row.catalystState === "confirmed"
      ? row.catalystEvidence?.[0] && this.safeUrl(row.catalystEvidence[0].url)
        ? `<a class="text-button" href="${this.escape(row.catalystEvidence[0].url)}" target="_blank" rel="noopener noreferrer">Confirmed</a>`
        : "Confirmed"
      : news ?? (row.catalystState === "no-evidence" ? "None found"
      : row.catalystState === "source-unavailable" ? "Unchecked"
      : "Checking…");
    const verdict = this.overallVerdict(row, this.ticksFor(row));
    return `<tr>
      <td><strong>${this.escape(row.symbol)}</strong><button class="help-tip" type="button" data-tip="${this.escape(this.companyTip(row))}" aria-label="${this.escape(this.companyTip(row))}">?</button><small>${this.escape(row.name)}${row.sector ? ` · ${this.escape(row.sector)}` : ""}</small><span class="verdict-chip mini ${verdict.cls}">${this.escape(verdict.label)}</span></td>
      <td class="num">${this.money(row.price)}<small>${this.escape(this.dataBadge(row))}</small></td>
      <td class="num ${moveClass}">${this.percent(row.changePercent)}</td>
      <td class="num">${row.relativeVolume > 0 ? `${row.relativeVolume.toFixed(1)}×` : "—"}</td>
      <td class="num">${this.compact(row.volume)}</td>
      <td class="num">${row.floatOrMarketCap !== null ? `${row.floatOrMarketCap.toFixed(0)}m` : "—"}</td>
      <td>${catalyst}</td>
      <td class="num">${row.score}</td>
      <td><button class="row-action" data-symbol="${this.escape(row.symbol)}">Plan</button></td>
    </tr>`;
  }

  private renderCryptoRow(row: Candidate) {
    const moveClass = row.changePercent >= 0 ? "positive" : "negative";
    const verdict = this.overallVerdict(row, this.ticksFor(row));
    return `<tr>
      <td><strong>${this.escape(this.displaySymbol(row))}</strong><button class="help-tip" type="button" data-tip="${this.escape(this.companyTip(row))}" aria-label="${this.escape(this.companyTip(row))}">?</button><small>${this.escape(row.venue)} · ${this.age(row.sourceTime)}</small><span class="verdict-chip mini ${verdict.cls}">${this.escape(verdict.label)}</span></td>
      <td class="num">${this.money(row.price)}</td>
      <td class="num">${this.metricValue(row.momentum5m, row.detailState)}</td>
      <td class="num">${this.metricValue(row.momentum1h, row.detailState)}</td>
      <td class="num ${moveClass}">${this.percent(row.changePercent)}</td>
      <td class="num">${row.relativeVolume.toFixed(1)}×</td>
      <td class="num">${row.spreadPercent.toFixed(2)}%</td>
      <td>${row.crossVenue ? "2 venues" : "Binance"}</td>
      <td class="num">${row.score}</td>
      <td><button class="row-action" data-symbol="${this.escape(row.symbol)}">Plan</button></td>
    </tr>`;
  }

  private dataBadge(row: Candidate) {
    if (row.assetClass === "crypto") return row.crossVenue ? "Live · 2 venues" : "Live · Binance";
    if (row.coverage === "delayed") return row.dataMode ?? "Delayed";
    return row.marketState === "REGULAR" ? "Live" : `Live · ${(row.marketState ?? "").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) || "off-hours"}`;
  }

  private displaySymbol(row: Candidate) {
    if (row.assetClass === "stocks") return row.symbol;
    return row.symbol.endsWith("USDT") ? row.symbol.slice(0, -4) : row.symbol;
  }

  /* ---------- Plan ---------- */

  private renderPlan() {
    const selected = this.selected;
    if (!selected) {
      return `<div class="empty-state" style="margin-top:24px"><strong>${this.simple ? "Pick something from the movers list first." : "Select a candidate first."}</strong><span>${this.simple ? "Open “What's moving” and choose “Make a plan” on any card." : "Open Discover and choose Plan on any row."}</span><button class="secondary-button" data-goto="discover">${this.simple ? "See what's moving" : "Open Discover"}</button></div>`;
    }
    const ticks = this.ticksFor(selected);
    const passes = ticks.filter((tick) => tick.state === "pass").length;
    const strong = passes >= 4;
    void this.ensurePullback(selected);
    const pullbackRecord = this.pullbacks.get(selected.symbol);
    const pullback = pullbackRecord?.result;
    const suggestedStop = pullback?.ready && pullback.pullbackLow < selected.price ? pullback.pullbackLow : selected.price * 0.98;
    const whatToDo = this.renderWhatToDo(selected, ticks, suggestedStop);
    return `
      <div class="plan-head">
        <div>
          <p class="eyebrow">${this.simple ? "Check & plan" : "Trade plan"}</p>
          <h1>${this.escape(this.displaySymbol(selected))}</h1>
          <div class="plan-price-line"><span class="plan-price">${this.money(selected.price)}</span><span class="num ${selected.changePercent >= 0 ? "positive" : "negative"}">${this.percent(selected.changePercent)}</span><span class="card-meta">${this.escape(selected.name)} · ${this.escape(this.dataBadge(selected))}</span></div>
        </div>
        <button class="secondary-button" data-goto="discover">${this.simple ? "Back to movers" : "Back to Discover"}</button>
      </div>
      ${whatToDo}
      <div class="plan-grid">
        <section class="panel">
          <p class="step-label">Step 1 — ${this.simple ? "Is it worth watching?" : "Quality gate"}</p>
          <h2>${strong ? (this.simple ? "Looks strong." : `${passes} of ${ticks.length} pillars pass`) : (this.simple ? "Be careful — it's missing things that usually matter." : `Only ${passes} of ${ticks.length} pillars pass`)}</h2>
          <div class="tick-row" style="margin-top:12px">
            ${ticks.map((tick) => `<span class="tick ${tick.state === "pass" ? "pass" : tick.state === "unknown" ? "unknown" : ""}"><span class="tick-mark">${tick.state === "pass" ? "✓" : tick.state === "unknown" ? "?" : "·"}</span><span>${this.escape(tick.label)} — ${this.escape(tick.detail)}</span></span>`).join("")}
          </div>
        </section>
        <section class="panel">
          <p class="step-label">Step 2 — ${this.simple ? "Is this a good moment?" : "Pullback check"}</p>
          ${this.renderMoment(pullback, pullbackRecord?.precision ?? "full")}
        </section>
        <section class="panel" style="grid-column:1/-1">
          <p class="step-label">${this.simple ? "The day so far" : "Intraday chart"}</p>
          ${pullbackRecord && pullbackRecord.candles.length
            ? `${renderDayChart(pullbackRecord.candles, { precision: pullbackRecord.precision, showGuides: true, markStop: suggestedStop })}
               ${pullbackRecord.precision === "full"
                 ? `<div class="chart-legend"><span><i class="swatch vwap"></i>${this.simple ? "Average price today" : "VWAP"}</span><span><i class="swatch ema"></i>${this.simple ? "Recent trend" : "9 EMA"}</span><span><i class="swatch stop"></i>${this.simple ? "Suggested get-out" : "Suggested stop"}</span></div>`
                 : `<div class="chart-legend"><span>${this.simple ? "Price line for the day — finer candle detail wasn't available for this one." : "Price-only source; OHLC candles unavailable."}</span></div>`}`
            : `<div class="chart-empty">${this.simple ? "Drawing the chart…" : "Loading candles…"}</div>`}
        </section>
        <section class="panel" style="grid-column:1/-1">
          <p class="step-label">Step 3 — ${this.simple ? "Plan your practice trade" : "Position size"}</p>
          <form id="plan-form" class="plan-form" novalidate>
            <label>${this.simple ? "Buy at about" : "Entry"}<input id="entry" type="number" min="0" step="any" value="${this.inputPrice(selected.price)}"></label>
            <label>${this.simple ? "Your get-out price" : "Stop"}<input id="stop" type="number" min="0" step="any" value="${this.inputPrice(suggestedStop)}"></label>
            <label>${this.simple ? "Most you'll risk losing" : "Maximum risk"}<input id="risk" type="number" min="1" step="any" value="${this.prefs.defaultRisk}"><span class="unit">$</span></label>
            <label>${this.simple ? "A win should pay" : "Reward multiple"}<select id="reward"><option value="2">${this.simple ? "2× the risk" : "2R"}</option><option value="2.5">${this.simple ? "2.5× the risk" : "2.5R"}</option><option value="3">${this.simple ? "3× the risk" : "3R"}</option></select></label>
            <div id="plan-summary" class="plan-summary" aria-live="polite"></div>
            <label class="wide">${this.simple ? "Why this trade? (optional)" : "Plan note"}<textarea id="note" rows="2" placeholder="${this.simple ? "e.g. Strong rise, clear reason, good moment" : "Why does this setup deserve a trade?"}"></textarea></label>
            <button class="primary-button wide" type="submit">${this.simple ? "Save practice trade" : "Save simulated plan"}</button>
          </form>
        </section>
      </div>`;
  }

  private renderWhatToDo(candidate: Candidate, ticks: Tick[], suggestedStop: number) {
    const verdict = this.overallVerdict(candidate, ticks);
    const moment = this.momentVerdict(candidate);
    const reasons = ticks.filter((tick) => tick.state === "pass").map((tick) => tick.label.toLowerCase());
    const why = reasons.length
      ? `It ticks ${verdict.passes} of ${ticks.length} quality boxes: ${reasons.join(", ")}.`
      : "It doesn't tick any of the quality boxes right now.";
    const target = candidate.price + (candidate.price - suggestedStop) * 2;
    let action: string;
    if (verdict.cls === "skip" || verdict.cls === "mid") {
      action = this.simple
        ? "This one is missing things that usually matter, so the safest move is to skip it and look at a stronger card."
        : "Below the quality bar — skip unless the missing pillars resolve.";
    } else if (moment === "entry") {
      action = this.simple
        ? `The moment looks right. In the simulator: buy near ${this.money(candidate.price)}, set your get-out at ${this.money(suggestedStop)}, and aim to sell around ${this.money(target)} — or get out early if it drops below your get-out price or a nasty rejection appears at the top.`
        : `Entry signal active. Entry ≈ ${this.money(candidate.price)}, stop ${this.money(suggestedStop)}, 2R target ≈ ${this.money(target)}.`;
    } else if (moment === "wait") {
      action = this.simple
        ? "Strong candidate, wrong moment. Don't buy yet — watch it, and only act when it stops falling and starts making new highs again (the check below will turn green)."
        : "Quality passes; pattern incomplete. Wait for the first candle to break the prior high.";
    } else if (moment === "avoid") {
      action = this.simple
        ? "It was strong earlier, but the healthy pattern has broken — it gave back too much or slipped below its average. Leave it unless a fresh rise starts."
        : "Pattern failed (deep retrace or below VWAP/EMA). Stand aside unless a new leg forms.";
    } else {
      action = this.simple
        ? "Still reading the chart to judge the moment — the verdict will appear in Step 2 below."
        : "Moment check pending — see Step 2.";
    }
    return `<section class="panel what-to-do verdict-${verdict.cls}">
      <p class="step-label">${this.simple ? "What to do right now" : "Verdict"}</p>
      <div class="verdict-chip ${verdict.cls}">${this.escape(verdict.label)}</div>
      <p class="wtd-why">${this.escape(why)}</p>
      <p class="wtd-action">${this.escape(action)}</p>
    </section>`;
  }

  private renderMoment(pullback: PullbackResult | undefined, precision: "full" | "price-only") {
    if (!pullback) return `<div class="moment-verdict unknown">${this.simple ? "Reading the chart…" : "Loading candles…"}</div>`;
    if (!pullback.ready) {
      const text = pullback.reason === "source-unavailable"
        ? this.simple ? "The chart data isn't available right now, so judge the moment yourself." : "Candle source unavailable — judge the setup manually."
        : this.simple ? "There isn't enough trading history yet to judge the moment." : "Not enough candles to analyse a pullback yet.";
      return `<div class="moment-verdict unknown">${text}</div>`;
    }
    const sentence = pullback.verdict === "entry"
      ? this.simple ? "It rose, took a breather, and is starting to climb again — this is the moment the strategy looks for." : "Pullback held and the latest candle is breaking the prior high — valid entry signal."
      : pullback.verdict === "avoid"
        ? pullback.retracementPercent > 50
          ? this.simple ? "It gave back too much of its rise — better to wait for a fresh move." : `Retraced ${pullback.retracementPercent.toFixed(0)}% of the move — pattern failed.`
          : this.simple ? "It has slipped below its average price today — better to stay out." : "Price is below VWAP and the 9 EMA — no edge."
        : pullback.toppingTail
          ? this.simple ? "Buyers pushed it up but sellers shoved it straight back — a common warning sign. Wait." : "Topping tail on the latest candle — wait."
          : this.simple ? "It's taking a breather. Wait for it to start climbing again before acting." : "Pullback in progress — wait for the first candle to break the prior high.";
    const priceOnly = precision === "price-only";
    const checks = [
      { label: this.simple ? "Kept most of its rise" : "Retracement ≤ 50%", pass: pullback.retracementPercent <= 50, detail: pullback.retracementPercent > 100 ? (this.simple ? "gave it all back" : ">100%") : `${this.simple ? `gave back ${pullback.retracementPercent.toFixed(0)}%` : `${pullback.retracementPercent.toFixed(0)}%`}` },
      ...priceOnly ? [] : [
        { label: this.simple ? "Buyers busier than sellers" : "Green volume ≥ red volume", pass: pullback.greenVolumeDominant, detail: "" },
        { label: this.simple ? "Above its average price today" : "Above VWAP", pass: pullback.aboveVwap, detail: this.money(pullback.vwap) }
      ],
      { label: this.simple ? "Above its recent trend" : "Above 9 EMA", pass: pullback.aboveEma9, detail: this.money(pullback.ema9) },
      ...priceOnly ? [] : [{ label: this.simple ? "No nasty rejection at the top" : "No topping tail", pass: !pullback.toppingTail, detail: "" }],
      { label: this.simple ? "Starting to climb again" : "Breaking prior candle high", pass: pullback.breakingHigher, detail: "" }
    ];
    return `
      <div class="moment-verdict ${pullback.verdict}">${sentence}</div>
      <div class="check-list">
        ${checks.map((check) => `<span class="tick ${check.pass ? "pass" : ""}"><span class="tick-mark">${check.pass ? "✓" : "·"}</span><span>${this.escape(check.label)}${check.detail ? ` — ${this.escape(check.detail)}` : ""}</span></span>`).join("")}
      </div>
      ${priceOnly ? `<p class="card-meta" style="margin:12px 0 0">${this.simple ? "Based on price movements only — volume detail wasn't available, so treat this reading as rough." : "Price-only source: volume, VWAP and wick checks unavailable."}</p>` : ""}
      <p class="card-meta" style="margin:12px 0 0">${this.simple ? `Suggested get-out price: ${this.money(pullback.pullbackLow)} (the low of the breather).` : `Suggested stop: ${this.money(pullback.pullbackLow)} (pullback low).`}</p>`;
  }

  /* ---------- Journal ---------- */

  private resolvedEntries() {
    return this.journal.filter((entry) => entry.outcome !== undefined);
  }

  private entryPnl(entry: JournalEntry) {
    return (entry.outcome ?? 0) * entry.risk;
  }

  private todayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
  }

  private todaysResolved() {
    const today = this.todayKey();
    return this.resolvedEntries().filter((entry) => entry.createdAt.slice(0, 10) === today);
  }

  private renderJournal() {
    const resolved = this.resolvedEntries();
    const wins = resolved.filter((entry) => (entry.outcome ?? 0) > 0);
    const losses = resolved.filter((entry) => (entry.outcome ?? 0) <= 0);
    const accuracy = resolved.length ? Math.round((wins.length / resolved.length) * 100) : 0;
    const avgWin = wins.length ? wins.reduce((sum, entry) => sum + this.entryPnl(entry), 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((sum, entry) => sum + this.entryPnl(entry), 0) / losses.length) : 0;
    const greenWeeks = this.greenWeeks();
    return `
      <div class="discover-head">
        <div><p class="eyebrow">${this.simple ? "Your coach" : "Process review"}</p><h1>${this.simple ? "How you're doing" : "Journal"}</h1><p class="lede">${this.simple ? "Every practice trade you save lands here, along with what the numbers say about your habits." : "Review decisions, not just outcomes."}</p></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button class="secondary-button" id="record-no-trade">${this.simple ? "Record a no-trade day" : "Log no-trade day"}</button>
          <button class="secondary-button" id="export-journal" ${this.journal.length ? "" : "disabled"}>Export</button>
        </div>
      </div>
      ${this.renderCoach()}
      <div class="metric-row">
        <div class="metric"><span>${this.simple ? "Practice trades" : "Resolved trades"}</span><strong class="num">${resolved.length}</strong></div>
        <div class="metric"><span>${this.simple ? "Times you were right" : "Accuracy"}</span><strong class="num">${resolved.length ? `${accuracy}%` : "—"}</strong></div>
        <div class="metric"><span>${this.simple ? "Average win" : "Avg winner"}</span><strong class="num positive">${wins.length ? this.money(avgWin) : "—"}</strong></div>
        <div class="metric"><span>${this.simple ? "Average loss" : "Avg loser"}</span><strong class="num negative">${losses.length ? this.money(avgLoss) : "—"}</strong></div>
        <div class="metric"><span>${this.simple ? "Positive weeks (last 6)" : "Green weeks / 6"}</span><strong class="num">${greenWeeks.total ? `${greenWeeks.green} of ${greenWeeks.total}` : "—"}</strong></div>
      </div>
      ${this.renderDayChips()}
      ${this.renderInsights(resolved)}
      <section class="panel">
        <div class="section-heading"><h2>${this.simple ? "Your practice trades" : "Simulated plans"}</h2>
          <label class="mode-toggle">${this.simple ? "Daily safety limit" : "Max daily loss"} <input id="loss-limit" type="number" min="10" step="10" value="${this.prefs.dailyLossLimit}" style="width:90px; min-height:36px; background:var(--bg); border:1px solid var(--line-strong); border-radius:8px; color:var(--text); padding:6px 8px" class="num"> $</label>
        </div>
        ${this.journal.length ? `<div class="journal-list">${this.journal.map((entry) => this.renderJournalEntry(entry)).join("")}</div>` : `<div class="empty-state"><strong>${this.simple ? "No practice trades yet." : "No plans yet."}</strong><span>${this.simple ? "Pick a mover, check the moment, plan the trade — it will appear here." : "Select a candidate and define the risk."}</span></div>`}
      </section>`;
  }

  private renderCoach() {
    const today = this.todaysResolved().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const pnl = today.reduce((sum, entry) => sum + this.entryPnl(entry), 0);
    let running = 0;
    let peak = 0;
    for (const entry of today) {
      running += this.entryPnl(entry);
      peak = Math.max(peak, running);
    }
    const gaveBackHalf = peak > 0 && running <= peak / 2;
    const session = newYorkSession();
    if (pnl <= -this.prefs.dailyLossLimit) {
      return `<div class="coach-banner stop"><span class="coach-icon">✋</span><p><strong>You've reached your daily safety limit (${this.money(this.prefs.dailyLossLimit)}).</strong> ${this.simple ? "Today's practice is done — losses grow fastest when we chase them. See you tomorrow." : "Stop trading for the day; review the entries below instead."}</p></div>`;
    }
    if (gaveBackHalf) {
      return `<div class="coach-banner warn"><span class="coach-icon">⚠️</span><p><strong>You've handed back half of today's gain.</strong> ${this.simple ? "This is usually the best moment to stop while the day is still positive." : `Peak was ${this.money(peak)}; now ${this.money(running)}. Historically the highest-risk moment to keep going.`}</p></div>`;
    }
    if (session.phase === "open" && !session.prime && today.length) {
      return `<div class="coach-banner warn"><span class="coach-icon">🕙</span><p><strong>${this.simple ? "The liveliest part of the day is over." : "Past the prime window."}</strong> ${this.simple ? "Most momentum traders do their best work before 10am New York time. Trades from here on deserve extra caution." : "Ross-style momentum performance typically degrades after 10:00 ET."}</p></div>`;
    }
    if (!today.length && this.noTradeDays.includes(this.todayKey())) {
      return `<div class="coach-banner"><span class="coach-icon">💪</span><p><strong>No trade today — that took discipline.</strong> ${this.simple ? "Skipping a weak day protects your results more than any single win." : "A recorded no-trade day counts towards consistency."}</p></div>`;
    }
    if (pnl > 0) {
      return `<div class="coach-banner"><span class="coach-icon">✅</span><p><strong>Today is positive: ${this.money(pnl)}.</strong> ${this.simple ? "Protect it — if you give half of it back, stop." : `Half-back rule armed at ${this.money(pnl / 2)}.`}</p></div>`;
    }
    return "";
  }

  private renderDayChips() {
    const days: string[] = [];
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      days.push(date.toISOString().slice(0, 10));
    }
    const byDay = new Map<string, number>();
    for (const entry of this.resolvedEntries()) {
      const day = entry.createdAt.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + this.entryPnl(entry));
    }
    return `<div class="day-chips" aria-label="${this.simple ? "Last 14 days" : "Daily results, last 14 days"}">${days.map((day) => {
      const pnl = byDay.get(day);
      const skipped = this.noTradeDays.includes(day);
      const cls = pnl === undefined ? (skipped ? "skip" : "") : pnl > 0 ? "win" : pnl < 0 ? "loss" : "";
      const title = pnl !== undefined ? `${day}: ${this.money(pnl)}` : skipped ? `${day}: no-trade day` : `${day}: nothing recorded`;
      return `<span class="day-chip ${cls}" title="${title}">${Number(day.slice(8, 10))}</span>`;
    }).join("")}</div>`;
  }

  private renderInsights(resolved: JournalEntry[]) {
    const insights: string[] = [];
    const byHour = new Map<number, { pnl: number; count: number }>();
    for (const entry of resolved) {
      const hour = new Date(entry.createdAt).getHours();
      const bucket = byHour.get(hour) ?? { pnl: 0, count: 0 };
      bucket.pnl += this.entryPnl(entry);
      bucket.count += 1;
      byHour.set(hour, bucket);
    }
    let worst: { hour: number; pnl: number } | null = null;
    byHour.forEach((bucket, hour) => {
      if (bucket.count >= 3 && bucket.pnl < 0 && (!worst || bucket.pnl < worst.pnl)) worst = { hour, pnl: bucket.pnl };
    });
    if (worst !== null) {
      const { hour, pnl } = worst as { hour: number; pnl: number };
      insights.push(this.simple
        ? `Most of your losses happen around ${hour}:00. Consider stopping before then.`
        : `Trades opened around ${hour}:00 have cost you ${this.money(Math.abs(pnl))} in total. Consider a cutoff.`);
    }
    const wins = resolved.filter((entry) => (entry.outcome ?? 0) > 0).length;
    if (resolved.length >= 10 && wins / resolved.length >= 0.5) {
      insights.push(this.simple
        ? "You're right more often than not, and your wins are planned to pay more than your losses — that combination is what works. Keep the process identical."
        : "Accuracy ≥ 50% with a ≥2R plan is a durable edge. Keep the process identical.");
    }
    if (!insights.length) return "";
    return `<ul class="insight-list">${insights.map((insight) => `<li>${this.escape(insight)}</li>`).join("")}</ul>`;
  }

  private renderJournalEntry(entry: JournalEntry) {
    const rMultiple = entry.entry > entry.stop ? (entry.target - entry.entry) / (entry.entry - entry.stop) : 2;
    const outcome = entry.outcome;
    return `<article class="journal-entry">
      <div class="je-symbol">${this.escape(entry.symbol.endsWith("USDT") ? entry.symbol.slice(0, -4) : entry.symbol)}<small>${new Date(entry.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div>
      <div class="je-figures">
        <span>${this.simple ? "In" : "Entry"}<strong>${this.money(entry.entry)}</strong></span>
        <span>${this.simple ? "Get-out" : "Stop"}<strong>${this.money(entry.stop)}</strong></span>
        <span>${this.simple ? "Aim" : "Target"}<strong>${this.money(entry.target)}</strong></span>
        <span>${this.simple ? "Size" : "Units"}<strong>${entry.shares.toLocaleString("en-GB")}</strong></span>
        <span>${this.simple ? "At risk" : "Risk"}<strong>${this.money(entry.risk)}</strong></span>
      </div>
      <div class="je-actions">
        ${outcome === undefined
          ? `<button class="text-button" data-outcome="${rMultiple.toFixed(2)}" data-entry-id="${entry.id}">${this.simple ? "It won" : "Win"}</button><button class="text-button danger" data-outcome="-1" data-entry-id="${entry.id}">${this.simple ? "It lost" : "Loss"}</button>`
          : `<span class="outcome-chip ${outcome > 0 ? "win" : "loss"}">${outcome > 0 ? "+" : "−"}${this.money(Math.abs(this.entryPnl(entry)))}</span>`}
        <button class="text-button ${this.pendingDeleteId === entry.id ? "danger" : ""}" data-delete-entry="${entry.id}">${this.pendingDeleteId === entry.id ? "Confirm delete" : "Delete"}</button>
      </div>
      ${entry.note ? `<p class="je-note">${this.escape(entry.note)}</p>` : ""}
    </article>`;
  }

  private greenWeeks() {
    const resolved = this.resolvedEntries();
    if (!resolved.length) return { green: 0, total: 0 };
    const weekPnl = new Map<string, number>();
    const now = Date.now();
    for (const entry of resolved) {
      const created = new Date(entry.createdAt).getTime();
      const weeksAgo = Math.floor((now - created) / (7 * 24 * 3_600_000));
      if (weeksAgo > 5) continue;
      const key = String(weeksAgo);
      weekPnl.set(key, (weekPnl.get(key) ?? 0) + this.entryPnl(entry));
    }
    const values = [...weekPnl.values()];
    return { green: values.filter((value) => value > 0).length, total: values.length };
  }

  /* ---------- Events ---------- */

  private bind() {
    this.root.querySelectorAll<HTMLButtonElement>("[data-asset]").forEach((button) => button.addEventListener("click", () => {
      this.assetClass = button.dataset.asset as AssetClass;
      this.selected = undefined;
      if (this.view === "plan") this.view = "discover";
      this.render();
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => {
      this.prefs.mode = button.dataset.mode as Mode;
      this.savePrefs();
      this.render();
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => {
      this.view = button.dataset.view as View;
      this.render();
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-goto]").forEach((button) => button.addEventListener("click", () => {
      this.view = button.dataset.goto as View;
      this.render();
    }));
    this.bindCandidateActions();
    this.bindFilters();
    this.root.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("input", () => this.updatePlanSummary());
    this.root.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("submit", (event) => this.savePlan(event));
    this.root.querySelector<HTMLButtonElement>("#export-journal")?.addEventListener("click", () => this.journalStore.export(this.journal));
    this.root.querySelector<HTMLButtonElement>("#record-no-trade")?.addEventListener("click", () => {
      const today = this.todayKey();
      if (!this.noTradeDays.includes(today)) {
        this.noTradeDays.push(today);
        localStorage.setItem(NO_TRADE_KEY, JSON.stringify(this.noTradeDays));
      }
      this.render();
    });
    this.root.querySelector<HTMLInputElement>("#loss-limit")?.addEventListener("change", (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      if (Number.isFinite(value) && value > 0) {
        this.prefs.dailyLossLimit = value;
        this.savePrefs();
      }
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-outcome]").forEach((button) => button.addEventListener("click", () => {
      const entry = this.journal.find((item) => item.id === button.dataset.entryId);
      if (!entry) return;
      entry.outcome = Number(button.dataset.outcome);
      this.journalStore.save(this.journal);
      this.render();
    }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-delete-entry]").forEach((button) => button.addEventListener("click", () => {
      const entry = this.journal.find((item) => item.id === button.dataset.deleteEntry);
      if (!entry) return;
      if (this.pendingDeleteId !== entry.id) {
        this.pendingDeleteId = entry.id;
        this.render();
        return;
      }
      this.journal = this.journal.filter((item) => item.id !== entry.id);
      this.pendingDeleteId = undefined;
      this.journalStore.save(this.journal);
      this.render();
    }));
    this.updatePlanSummary();
  }

  private bindCandidateActions() {
    // Delegated so live refreshes that replace card markup never orphan a click.
    this.root.querySelector<HTMLElement>("#candidate-results")?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-symbol]");
      if (!button) return;
      const pool = this.assetClass === "stocks" ? this.stockCandidates : this.cryptoCandidates;
      this.selected = pool.find((candidate) => candidate.symbol === button.dataset.symbol) ?? this.selected;
      this.view = "plan";
      this.render();
    });
  }

  private bindFilters() {
    this.root.querySelectorAll<HTMLInputElement>(".filter-grid input[type='number']").forEach((input) => input.addEventListener("input", () => {
      const current = this.filters[this.assetClass];
      current.minPrice = this.numberValue("#min-price", current.minPrice);
      current.maxPrice = this.numberValue("#max-price", current.maxPrice);
      current.minChange = this.numberValue("#min-change", current.minChange);
      current.minRelativeVolume = this.numberValue("#min-rvol", current.minRelativeVolume);
      current.maxFloatMillions = this.numberValue("#max-float", current.maxFloatMillions);
      current.minQuoteVolumeMillions = this.numberValue("#min-volume", current.minQuoteVolumeMillions);
      current.maxSpreadPercent = this.numberValue("#max-spread", current.maxSpreadPercent);
      this.rescoreAll();
      this.refreshCandidateResults();
    }));
    this.root.querySelector<HTMLInputElement>("#chime")?.addEventListener("change", (event) => {
      this.prefs.chime = (event.currentTarget as HTMLInputElement).checked;
      this.savePrefs();
      if (this.prefs.chime) this.beep();
    });
    this.root.querySelector<HTMLButtonElement>("#reset-filters")?.addEventListener("click", () => {
      this.filters[this.assetClass] = structuredClone(defaultFilters[this.assetClass]);
      this.rescoreAll();
      this.render();
    });
  }

  private rescoreAll() {
    this.stockCandidates = this.stockCandidates.map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, this.filters.stocks) }));
    this.cryptoCandidates = this.cryptoCandidates.map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, this.filters.crypto) }));
  }

  private refreshDiscoverData() {
    this.refreshSessionStrip();
    if (this.view !== "discover") return;
    this.refreshCandidateResults();
  }

  private refreshCandidateResults() {
    const results = this.root.querySelector<HTMLElement>("#candidate-results");
    if (!results || results.contains(document.activeElement)) return;
    results.innerHTML = this.renderCandidates();
  }

  /* ---------- Plan form ---------- */

  private updatePlanSummary() {
    const output = this.root.querySelector<HTMLElement>("#plan-summary");
    if (!output || !this.selected) return;
    const entry = this.numberValue("#entry", 0);
    const stop = this.numberValue("#stop", 0);
    const risk = this.numberValue("#risk", 0);
    const reward = this.numberValue("#reward", 2);
    const plan = calculatePlan(entry, stop, risk, reward);
    const entryInput = this.root.querySelector<HTMLInputElement>("#entry");
    const stopInput = this.root.querySelector<HTMLInputElement>("#stop");
    const riskInput = this.root.querySelector<HTMLInputElement>("#risk");
    entryInput?.setAttribute("aria-invalid", String(!(entry > 0) || entry <= stop));
    stopInput?.setAttribute("aria-invalid", String(!(stop >= 0) || stop >= entry));
    riskInput?.setAttribute("aria-invalid", String(!(risk > 0)));
    if (!plan.valid) {
      output.className = "plan-summary invalid";
      output.textContent = this.simple
        ? "The get-out price must be below the buy price, and the risk must be a positive amount."
        : "Enter a positive price and risk amount, with the stop below the entry.";
      return;
    }
    const unitsLabel = this.selected.assetClass === "stocks" ? (plan.units === 1 ? "share" : "shares") : "units";
    output.className = "plan-summary";
    output.innerHTML = this.simple
      ? `Buy up to <strong>${plan.units.toLocaleString("en-GB")}</strong> ${unitsLabel} at about <strong>${this.money(entry)}</strong>. If it falls to <strong>${this.money(stop)}</strong>, get out — you'd lose about <strong>${this.money(risk)}</strong>. Aim to sell at <strong>${this.money(plan.target)}</strong> or better, so a win pays about <strong>${this.money(risk * reward)}</strong>.`
      : `<strong>${plan.units.toLocaleString("en-GB")}</strong> ${unitsLabel} · risk/unit <strong>${this.money(plan.riskPerUnit)}</strong> · target <strong>${this.money(plan.target)}</strong> (${reward}R = ${this.money(risk * reward)}).`;
  }

  private savePlan(event: SubmitEvent) {
    event.preventDefault();
    if (!this.selected) return;
    const entry = this.numberValue("#entry", 0);
    const stop = this.numberValue("#stop", 0);
    const risk = this.numberValue("#risk", 0);
    const reward = this.numberValue("#reward", 2);
    const plan = calculatePlan(entry, stop, risk, reward);
    if (!plan.valid) return;
    this.prefs.defaultRisk = risk;
    this.savePrefs();
    this.journal.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      symbol: this.selected.symbol,
      assetClass: this.selected.assetClass,
      entry,
      stop,
      target: plan.target,
      shares: plan.units,
      risk,
      note: this.root.querySelector<HTMLTextAreaElement>("#note")?.value.trim() ?? ""
    });
    this.journalStore.save(this.journal);
    this.view = "journal";
    this.render();
  }

  /* ---------- Formatting ---------- */

  private numberValue(selector: string, fallback: number) {
    const element = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    if (!element) return fallback;
    const value = Number(element.value);
    return Number.isFinite(value) ? value : fallback;
  }

  private money(value: number) {
    const maximumFractionDigits = Math.abs(value) < 1 ? 4 : 2;
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD", maximumFractionDigits }).format(value);
  }

  private inputPrice(value: number) {
    return Number(value.toPrecision(6)).toString();
  }

  private compact(value: number) {
    return new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }

  private percent(value: number) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
  }

  private metricValue(value: number | null | undefined, state: Candidate["detailState"]) {
    if (value !== null && value !== undefined) return this.percent(value);
    if (state === "loading" || state === "queued") return "…";
    return "—";
  }

  private safeUrl(value: string) {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }

  private age(timestamp: number) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
    if (seconds < 2) return "now";
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ago`;
  }

  private escape(value: string) {
    return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
  }
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing");
new App(root);
