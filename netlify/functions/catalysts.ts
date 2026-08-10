import { createMemoryCatalystCache, lookupOfficialCatalysts } from "../../src/catalyst-service";

const sourceCache = createMemoryCatalystCache();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export default async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "Use POST" });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 8_192) return json(413, { error: "Request body is too large" });
  try {
    const payload = await request.json();
    const reports = await lookupOfficialCatalysts(payload, {
      secUserAgent: Netlify.env.get("SEC_USER_AGENT"),
      cache: sourceCache
    });
    return json(200, { reports });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid catalyst request";
    return json(400, { error: message });
  }
};
