import { fetchGoogleNews } from "../../server/google-news";

const cache = new Map<string, { payload: unknown; at: number }>();
const CACHE_MS = 5 * 60_000;

export default async function handler(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const cached = cache.get(query);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return json(200, cached.payload);
    }
    const payload = await fetchGoogleNews(query);
    cache.set(query, { payload, at: Date.now() });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return json(200, payload);
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : "News source unavailable" });
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" }
  });
}

export const config = { path: "/api/news" };
