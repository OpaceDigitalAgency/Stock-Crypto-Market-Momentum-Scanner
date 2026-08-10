type CoinbaseTicker = {
  product_id: string;
  price: string;
};

type CoinbaseMessage = {
  channel?: string;
  events?: Array<{ tickers?: CoinbaseTicker[] }>;
};

export const COINBASE_MARKET_ENDPOINT = "wss://advanced-trade-ws.coinbase.com";

export function parseCoinbasePrices(raw: string) {
  const prices = new Map<string, number>();
  try {
    const message = JSON.parse(raw) as CoinbaseMessage;
    if (message.channel !== "ticker" && message.channel !== "ticker_batch") return prices;
    for (const event of message.events ?? []) {
      for (const ticker of event.tickers ?? []) {
        const price = Number(ticker.price);
        if (typeof ticker.product_id === "string" && Number.isFinite(price) && price > 0) {
          prices.set(ticker.product_id, price);
        }
      }
    }
  } catch {
    return prices;
  }
  return prices;
}

export class CoinbaseFeed {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: number;
  private firstDataTimer?: number;
  private healthTimer?: number;
  private lastTickerMessage = 0;
  private liveReported = false;

  constructor(
    private readonly productIds: string[],
    private readonly onPrices: (prices: Map<string, number>) => void,
    private readonly onStatus: (status: "connecting" | "live" | "error" | "closed") => void
  ) {}

  connect() {
    if (!this.productIds.length) return;
    this.stopped = false;
    this.clearTimers();
    this.onStatus("connecting");
    const socket = new WebSocket(COINBASE_MARKET_ENDPOINT);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", product_ids: this.productIds, channel: "ticker_batch" }));
      socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
      this.firstDataTimer = window.setTimeout(() => this.failCurrentSocket(socket), 12_000);
      this.healthTimer = window.setInterval(() => {
        if (this.lastTickerMessage && Date.now() - this.lastTickerMessage > 20_000) this.failCurrentSocket(socket);
      }, 5_000);
    });
    socket.addEventListener("message", (event) => this.consume(String(event.data)));
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.onStatus("error");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearTimers();
      this.invalidatePrices();
      this.onStatus("closed");
      if (!this.stopped) this.reconnectTimer = window.setTimeout(() => this.connect(), 4_000);
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.invalidatePrices();
    this.socket?.close();
    this.socket = undefined;
  }

  private consume(raw: string) {
    const prices = parseCoinbasePrices(raw);
    if (!prices.size) return;
    this.lastTickerMessage = Date.now();
    if (this.firstDataTimer) window.clearTimeout(this.firstDataTimer);
    this.firstDataTimer = undefined;
    if (!this.liveReported) {
      this.liveReported = true;
      this.onStatus("live");
    }
    this.onPrices(prices);
  }

  private failCurrentSocket(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.onStatus("error");
    this.invalidatePrices();
    socket.close();
  }

  private invalidatePrices() {
    this.onPrices(new Map(this.productIds.map((productId) => [productId, Number.NaN])));
  }

  private clearTimers() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.firstDataTimer) window.clearTimeout(this.firstDataTimer);
    if (this.healthTimer) window.clearInterval(this.healthTimer);
    this.reconnectTimer = undefined;
    this.firstDataTimer = undefined;
    this.healthTimer = undefined;
    this.lastTickerMessage = 0;
    this.liveReported = false;
  }
}
