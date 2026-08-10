import type { JournalEntry } from "./types";

const key = "pulseboard-journal-v1";

export function parseJournal(value: string | null): JournalEntry[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is JournalEntry => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as Record<string, unknown>;
      const numbers = [item.entry, item.stop, item.target, item.shares, item.risk];
      return typeof item.id === "string"
        && typeof item.createdAt === "string"
        && typeof item.symbol === "string"
        && (item.assetClass === "stocks" || item.assetClass === "crypto")
        && numbers.every((number) => typeof number === "number" && Number.isFinite(number))
        && (item.outcome === undefined || typeof item.outcome === "number" && Number.isFinite(item.outcome))
        && typeof item.note === "string";
    });
  } catch {
    return [];
  }
}

export class JournalStore {
  load(): JournalEntry[] {
    return parseJournal(localStorage.getItem(key));
  }

  save(entries: JournalEntry[]) {
    localStorage.setItem(key, JSON.stringify(entries));
  }

  export(entries: JournalEntry[]) {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `pulseboard-journal-${new Date().toISOString().slice(0, 10)}.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    const href = link.href;
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(href);
    }, 1_000);
  }
}
