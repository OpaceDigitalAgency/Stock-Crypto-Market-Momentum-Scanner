import { defineConfig, type Plugin } from "vite";
import { fetchStockCandles, fetchTopStocks } from "./server/yahoo.ts";

// Serves the same /api routes locally that Netlify Functions serve in production,
// so `npm run dev` shows live stock data without any extra tooling.
function marketDataDev(): Plugin {
  let stocksCache: { payload: unknown; at: number } | null = null;
  return {
    name: "market-data-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL((req as { url?: string }).url ?? "/", "http://localhost");
        const respond = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (url.pathname === "/api/stocks") {
          void (async () => {
            try {
              if (!stocksCache || Date.now() - stocksCache.at > 45_000) {
                stocksCache = { payload: await fetchTopStocks(), at: Date.now() };
              }
              respond(200, stocksCache.payload);
            } catch (error) {
              if (stocksCache) respond(200, stocksCache.payload);
              else respond(502, { error: error instanceof Error ? error.message : "Stock source unavailable" });
            }
          })();
          return;
        }
        if (url.pathname === "/api/candles") {
          void (async () => {
            try {
              respond(200, await fetchStockCandles(url.searchParams.get("symbol") ?? ""));
            } catch (error) {
              respond(502, { error: error instanceof Error ? error.message : "Candle source unavailable" });
            }
          })();
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  build: { target: "es2022" },
  server: { port: 4173, strictPort: true },
  plugins: [marketDataDev()]
});
