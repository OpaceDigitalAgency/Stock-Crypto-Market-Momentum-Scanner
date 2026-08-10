import { fetchStockCandles } from "../../server/yahoo";

export default async function handler(request: Request): Promise<Response> {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  try {
    const payload = await fetchStockCandles(symbol);
    return new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=30"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Candle source unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
  }
}

export const config = { path: "/api/candles" };
