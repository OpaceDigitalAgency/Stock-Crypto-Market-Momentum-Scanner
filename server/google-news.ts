import { classifyHeadline, isRoundupHeadline } from "./headlines";
import type { SymbolNews } from "./yahoo";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_AGE_MS = 48 * 3_600_000;

interface RssItem {
  title: string;
  link?: string;
  publisher?: string;
  publishedAt?: number;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    if (!title) continue;
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    const publisher = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1];
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const publishedAt = pubDate ? Date.parse(pubDate) : undefined;
    items.push({
      title: decodeEntities(title).trim(),
      link: link ? decodeEntities(link).trim() : undefined,
      publisher: publisher ? decodeEntities(publisher).trim() : undefined,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : undefined
    });
  }
  return items;
}

/**
 * Recent Google News headlines for a search query, preferring headlines that
 * explain the move (earnings, launches, deals) over market-roundup noise.
 */
export async function fetchGoogleNews(query: string): Promise<SymbolNews & { kind?: string }> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 60 || /[<>"']/.test(trimmed)) throw new Error("Invalid news query");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(trimmed)}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Google News responded ${response.status}`);
  const now = Date.now();
  const recent = parseRss(await response.text())
    .filter((item) => item.publishedAt === undefined || now - item.publishedAt < MAX_AGE_MS)
    .slice(0, 15);
  // Prefer headlines that actually mention the subject (ticker or name),
  // so a generic market story is never presented as this asset's reason.
  const subjects = trimmed.split(/\s+/).filter((token) => !/^(stock|stocks|crypto|share|shares)$/i.test(token));
  const mentionsSubject = (title: string) => subjects.some((token) => new RegExp(`(^|[^A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(title));
  const onSubject = recent.filter((item) => mentionsSubject(item.title));
  const informative = onSubject.filter((item) => !isRoundupHeadline(item.title));
  // Prefer a headline that classifies into a concrete reason category.
  const classified = informative.find((item) => classifyHeadline(item.title) !== null);
  const top = classified ?? informative[0];
  return {
    count: informative.length,
    topTitle: top?.title,
    topUrl: top?.link,
    publisher: top?.publisher,
    publishedAt: top?.publishedAt ? new Date(top.publishedAt).toISOString() : undefined,
    kind: top ? classifyHeadline(top.title) ?? undefined : undefined
  };
}
