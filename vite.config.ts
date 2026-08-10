import { defineConfig, type Plugin } from "vite";
import { createCatalystCache, runCatalystLookup } from "./server/catalysts-core.ts";
import { fetchGoogleNews } from "./server/google-news.ts";
import { fetchCandlesAnySource, fetchStocksAnySource } from "./server/stocks-source.ts";

// Serves the same /api routes locally that Netlify Functions serve in production,
// so `npm run dev` shows live stock data without any extra tooling.
function marketDataDev(): Plugin {
  let stocksCache: { payload: unknown; at: number } | null = null;
  const catalystCache = createCatalystCache();
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
                stocksCache = { payload: await fetchStocksAnySource(), at: Date.now() };
              }
              respond(200, stocksCache.payload);
            } catch (error) {
              if (stocksCache) respond(200, stocksCache.payload);
              else respond(502, { error: error instanceof Error ? error.message : "Stock source unavailable" });
            }
          })();
          return;
        }
        if (url.pathname === "/api/news") {
          void (async () => {
            try {
              respond(200, await fetchGoogleNews(url.searchParams.get("q") ?? ""));
            } catch (error) {
              respond(502, { error: error instanceof Error ? error.message : "News source unavailable" });
            }
          })();
          return;
        }
        if (url.pathname === "/.netlify/functions/catalysts") {
          const stream = req as unknown as { on(event: string, callback: (chunk?: unknown) => void): void };
          let raw = "";
          stream.on("data", (chunk) => { raw += String(chunk); });
          stream.on("end", () => {
            void (async () => {
              try {
                const body: unknown = JSON.parse(raw || "{}");
                const reports = await runCatalystLookup(body, {
                  secUserAgent: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SEC_USER_AGENT,
                  cache: catalystCache
                });
                respond(200, { reports });
              } catch (error) {
                respond(400, { error: error instanceof Error ? error.message : "Invalid catalyst request" });
              }
            })();
          });
          return;
        }
        if (url.pathname === "/api/candles") {
          void (async () => {
            try {
              respond(200, await fetchCandlesAnySource(url.searchParams.get("symbol") ?? ""));
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
