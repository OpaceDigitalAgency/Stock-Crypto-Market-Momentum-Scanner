import type { CatalystEvidence } from "./catalyst-types";

export const SEC_TICKER_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_SUBMISSIONS_BASE = "https://data.sec.gov/submissions";

const EVENT_FORMS = /^(?:8-K|8-K\/A|6-K|6-K\/A|425|DEFA14A|S-1|S-1\/A|S-3|S-3\/A|424B\d+|SC 13D|SC 13D\/A|SC 13G|SC 13G\/A|SC TO-[A-Z]+|SC TO-[A-Z]+\/A)$/;

type SecTickerRecord = { cik_str?: unknown; ticker?: unknown; title?: unknown };

type SecRecentFilings = {
  accessionNumber?: unknown;
  filingDate?: unknown;
  acceptanceDateTime?: unknown;
  form?: unknown;
  primaryDocument?: unknown;
  primaryDocDescription?: unknown;
};

type SecSubmission = {
  cik?: unknown;
  name?: unknown;
  filings?: { recent?: SecRecentFilings };
};

export interface SecTickerMatch {
  symbol: string;
  cik: string;
  name: string;
}

export function parseSecTickerMap(payload: unknown): Map<string, SecTickerMatch> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("SEC ticker map is not an object");
  const matches = new Map<string, SecTickerMatch>();
  for (const value of Object.values(payload as Record<string, SecTickerRecord>)) {
    if (!value || typeof value !== "object") continue;
    const symbol = typeof value.ticker === "string" ? value.ticker.trim().toUpperCase() : "";
    const cikNumber = typeof value.cik_str === "number" ? value.cik_str : Number(value.cik_str);
    if (!/^[A-Z0-9.-]{1,15}$/.test(symbol) || !Number.isSafeInteger(cikNumber) || cikNumber <= 0) continue;
    matches.set(symbol, {
      symbol,
      cik: String(cikNumber).padStart(10, "0"),
      name: typeof value.title === "string" ? value.title.trim() : symbol
    });
  }
  if (!matches.size) throw new Error("SEC ticker map contains no valid records");
  return matches;
}

export function secSubmissionUrl(cik: string) {
  if (!/^\d{10}$/.test(cik)) throw new Error("SEC CIK must contain ten digits");
  return `${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`;
}

export function parseSecSubmission(
  payload: unknown,
  symbol: string,
  receivedAt: string,
  earliestFilingDate: string
): CatalystEvidence[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("SEC submission is not an object");
  const submission = payload as SecSubmission;
  const cikNumber = typeof submission.cik === "number" ? submission.cik : Number(submission.cik);
  const recent = submission.filings?.recent;
  if (!Number.isSafeInteger(cikNumber) || cikNumber <= 0 || !recent) throw new Error("SEC submission is missing its CIK or recent filings");

  const columns = [recent.accessionNumber, recent.filingDate, recent.form, recent.primaryDocument];
  if (!columns.every(Array.isArray)) throw new Error("SEC recent filing columns are invalid");
  const accessionNumbers = recent.accessionNumber as unknown[];
  const filingDates = recent.filingDate as unknown[];
  const forms = recent.form as unknown[];
  const primaryDocuments = recent.primaryDocument as unknown[];
  const accepted = Array.isArray(recent.acceptanceDateTime) ? recent.acceptanceDateTime : [];
  const descriptions = Array.isArray(recent.primaryDocDescription) ? recent.primaryDocDescription : [];
  const normalisedSymbol = symbol.trim().toUpperCase();

  const evidence: CatalystEvidence[] = [];
  for (let index = 0; index < accessionNumbers.length; index += 1) {
    const rawAccession = accessionNumbers[index];
    const rawFilingDate = filingDates[index];
    const rawForm = forms[index];
    const rawDocument = primaryDocuments[index];
    const accession = typeof rawAccession === "string" ? rawAccession : "";
    const filingDate = typeof rawFilingDate === "string" ? rawFilingDate : "";
    const form = typeof rawForm === "string" ? rawForm.trim().toUpperCase() : "";
    const document = typeof rawDocument === "string" ? rawDocument : "";
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) continue;
    if (filingDate < earliestFilingDate || !EVENT_FORMS.test(form) || !/^[A-Za-z0-9._-]+$/.test(document)) continue;
    const accessionPath = accession.replaceAll("-", "");
    const rawDescription = descriptions[index];
    const rawAcceptance = accepted[index];
    const description = typeof rawDescription === "string" && rawDescription.trim()
      ? rawDescription.trim()
      : `${form} filing`;
    const acceptance = typeof rawAcceptance === "string" && rawAcceptance
      ? rawAcceptance
      : `${filingDate}T00:00:00`;
    evidence.push({
      id: `sec-${accession}`,
      symbol: normalisedSymbol,
      source: "sec-edgar",
      sourceLabel: "SEC EDGAR",
      kind: "filing",
      title: `${form} filed with the SEC`,
      summary: description,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionPath}/${document}`,
      publishedAt: acceptance,
      receivedAt,
      confidence: "official",
      metadata: { form, accessionNumber: accession, filingDate }
    });
  }
  return evidence;
}
