import { describe, expect, it, vi } from "vitest";
import { parseNasdaqHalts } from "./catalyst-nasdaq";
import { parseSecSubmission, parseSecTickerMap, secSubmissionUrl } from "./catalyst-sec";
import { createMemoryCatalystCache, lookupOfficialCatalysts, validateCatalystRequest } from "./catalyst-service";
import { checkingCatalystReport } from "./catalyst-types";

const checkedAt = "2026-08-10T12:00:00.000Z";

const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/"><channel><item>
  <pubDate>Mon, 10 Aug 2026 11:30:00 GMT</pubDate><ndaq:HaltDate>08/10/2026</ndaq:HaltDate>
  <ndaq:HaltTime>07:25:51.787</ndaq:HaltTime><ndaq:IssueSymbol>TEST</ndaq:IssueSymbol>
  <ndaq:IssueName>Test &amp; Company</ndaq:IssueName><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>T1</ndaq:ReasonCode>
</item></channel></rss>`;

const tickerMap = { "0": { cik_str: 1234, ticker: "TEST", title: "Test Company" } };
const submission = {
  cik: 1234,
  filings: { recent: {
    accessionNumber: ["0000001234-26-000001", "0000001234-26-000002"],
    filingDate: ["2026-08-10", "2026-08-10"],
    acceptanceDateTime: ["2026-08-10T10:30:00", "2026-08-10T09:00:00"],
    form: ["8-K", "10-Q"],
    primaryDocument: ["event.htm", "quarter.htm"],
    primaryDocDescription: ["Current report", "Quarterly report"]
  } }
};

function response(body: unknown, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("official catalyst pipeline", () => {
  it("provides an explicit checking state", () => {
    expect(checkingCatalystReport(" test ", new Date(checkedAt))).toMatchObject({ symbol: "TEST", state: "checking", evidence: [] });
  });

  it("validates and deduplicates bounded requests", () => {
    expect(validateCatalystRequest({ symbols: ["test", "TEST"], lookbackDays: 2 })).toEqual({ symbols: ["TEST"], lookbackDays: 2 });
    expect(() => validateCatalystRequest({ symbols: ["A"], unexpected: true })).toThrow("unsupported");
    expect(() => validateCatalystRequest({ symbols: Array.from({ length: 9 }, (_, index) => `A${index}`) })).toThrow("between 1 and 8");
  });

  it("parses the official SEC ticker map and event filings only", () => {
    expect(parseSecTickerMap(tickerMap).get("TEST")?.cik).toBe("0000001234");
    expect(secSubmissionUrl("0000001234")).toBe("https://data.sec.gov/submissions/CIK0000001234.json");
    const evidence = parseSecSubmission(submission, "TEST", checkedAt, "2026-08-07");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ source: "sec-edgar", confidence: "official", metadata: { form: "8-K" } });
    expect(evidence[0].url).toContain("/1234/000000123426000001/event.htm");
  });

  it("parses official Nasdaq halt RSS without treating its HTML description as data", () => {
    expect(parseNasdaqHalts(rss, checkedAt)[0]).toMatchObject({
      symbol: "TEST", source: "nasdaq-halts", confidence: "official", metadata: { reasonCode: "T1" }
    });
    expect(() => parseNasdaqHalts("not rss", checkedAt)).toThrow("valid RSS");
  });

  it("confirms official evidence and sends the configured SEC user agent", async () => {
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const target = String(url);
      if (target.includes("nasdaqtrader")) return response(rss);
      if (target.includes("company_tickers")) return response(tickerMap);
      return response(submission);
    }) as unknown as typeof fetch;
    const reports = await lookupOfficialCatalysts({ symbols: ["TEST"] }, {
      fetch: request,
      now: () => new Date(checkedAt),
      secUserAgent: "Example Product compliance@example.com"
    });
    expect(reports[0].state).toBe("confirmed");
    expect(reports[0].evidence.map((item) => item.source).sort()).toEqual(["nasdaq-halts", "sec-edgar"]);
    const secCall = (request as ReturnType<typeof vi.fn>).mock.calls.find(([url]) => String(url).includes("sec.gov"));
    expect(secCall?.[1]?.headers).toMatchObject({ "user-agent": "Example Product compliance@example.com" });
  });

  it("fails closed when SEC_USER_AGENT is absent", async () => {
    const request = vi.fn(async () => response(`<?xml version="1.0"?><rss><channel></channel></rss>`)) as unknown as typeof fetch;
    const [report] = await lookupOfficialCatalysts({ symbols: ["TEST"] }, { fetch: request, now: () => new Date(checkedAt) });
    expect(report.state).toBe("source-unavailable");
    expect(report.sources).toContainEqual(expect.objectContaining({ source: "sec-edgar", available: false, message: "SEC_USER_AGENT is required" }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("distinguishes no evidence from an unavailable source", async () => {
    const emptyRss = `<?xml version="1.0"?><rss><channel></channel></rss>`;
    const available = vi.fn(async (url: string | URL | Request) => String(url).includes("nasdaqtrader") ? response(emptyRss) : String(url).includes("company_tickers") ? response(tickerMap) : response({ ...submission, filings: { recent: { ...submission.filings.recent, form: ["10-Q", "10-K"] } } })) as unknown as typeof fetch;
    const [noEvidence] = await lookupOfficialCatalysts({ symbols: ["TEST"] }, { fetch: available, now: () => new Date(checkedAt), secUserAgent: "Product contact@example.com" });
    expect(noEvidence.state).toBe("no-evidence");

    const unavailable = vi.fn(async (url: string | URL | Request) => String(url).includes("nasdaqtrader") ? response("down", 503) : response(tickerMap)) as unknown as typeof fetch;
    const [failed] = await lookupOfficialCatalysts({ symbols: ["TEST"] }, { fetch: unavailable, now: () => new Date(checkedAt), secUserAgent: "Product contact@example.com" });
    expect(failed.state).toBe("source-unavailable");
  });

  it("caches the minute-based Nasdaq feed and SEC source payloads", async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("nasdaqtrader")) return response(rss);
      if (target.includes("company_tickers")) return response(tickerMap);
      return response(submission);
    }) as unknown as typeof fetch;
    const cache = createMemoryCatalystCache();
    const options = { fetch: request, now: () => new Date(checkedAt), secUserAgent: "Product contact@example.com", cache };
    await lookupOfficialCatalysts({ symbols: ["TEST"] }, options);
    await lookupOfficialCatalysts({ symbols: ["TEST"] }, options);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
