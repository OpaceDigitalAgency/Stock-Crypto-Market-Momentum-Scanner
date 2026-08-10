import { describe, expect, it } from "vitest";
import { parseJournal } from "./storage";

const entry = {
  id: "entry-1",
  createdAt: "2026-08-10T12:00:00.000Z",
  symbol: "NOVA",
  assetClass: "stocks",
  entry: 10,
  stop: 9.5,
  target: 11,
  shares: 100,
  risk: 50,
  note: "A valid plan"
};

describe("journal persistence boundary", () => {
  it("loads valid saved entries", () => {
    expect(parseJournal(JSON.stringify([entry]))).toEqual([entry]);
  });

  it("returns an empty journal for malformed JSON or a non-array value", () => {
    expect(parseJournal("{broken")).toEqual([]);
    expect(parseJournal(JSON.stringify({ entry }))).toEqual([]);
  });

  it("drops corrupted entries while preserving valid plans", () => {
    const corrupted = { ...entry, id: "bad", note: 42 };
    expect(parseJournal(JSON.stringify([corrupted, entry]))).toEqual([entry]);
  });
});
