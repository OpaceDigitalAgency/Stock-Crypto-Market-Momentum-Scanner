import { fetchStocksAnySource } from "../../server/stocks-source";

let cache: { payload: unknown; at: number } | null = null;
const CACHE_MS = 45_000;

export default async function handler(): Promise<Response> {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      cache = { payload: await fetchStocksAnySource(), at: Date.now() };
    }
  } catch (error) {
    if (!cache) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Stock source unavailable" }), {
        status: 502,
        headers: { "content-type": "application/json" }
      });
    }
    // Serve the last good payload while the upstream source is rate limiting.
  }
  return new Response(JSON.stringify(cache.payload), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=15"
    }
  });
}

export const config = { path: "/api/stocks" };
