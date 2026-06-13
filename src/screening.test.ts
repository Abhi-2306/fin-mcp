/** Unit tests for the pure screening-criteria logic. No I/O. */

import { describe, expect, test } from "bun:test";
import { checkCriteria } from "./screening.ts";
import type { CompanyOverview } from "./provider.ts";

/** Build an overview with sensible defaults, overriding fields per test. */
function overview(partial: Partial<CompanyOverview> = {}): CompanyOverview {
  return {
    symbol: "X",
    name: "X Corp",
    sector: "Technology",
    industry: "Software",
    marketCap: 2_000_000_000_000,
    peRatio: 25,
    eps: 5,
    dividendYield: null,
    week52High: 200,
    week52Low: 100,
    description: "",
    ...partial,
  };
}

describe("checkCriteria()", () => {
  test("sector + PE-in-range + marketCap all pass → matched (no failures)", () => {
    const failures = checkCriteria(overview(), {
      sector: "Technology",
      minPe: 10,
      maxPe: 30,
      minMarketCap: 1_000_000_000_000,
    });
    expect(failures).toEqual([]);
  });

  test("wrong sector → failedCriteria has sector with expected vs actual", () => {
    const failures = checkCriteria(overview({ sector: "Energy" }), { sector: "Technology" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ criterion: "sector", expected: "Technology", actual: "Energy" });
  });

  test("PE above maxPe → failedCriteria has maxPe (expected/actual reported)", () => {
    const failures = checkCriteria(overview({ peRatio: 40 }), { maxPe: 30 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ criterion: "maxPe", expected: "<= 30", actual: "40" });
  });

  test("null PE with minPe set → fails (treated as not satisfying the floor)", () => {
    const failures = checkCriteria(overview({ peRatio: null }), { minPe: 10 });
    expect(failures.map((f) => f.criterion)).toContain("minPe");
    expect(failures[0]?.actual).toBe("null");
  });

  test("below minMarketCap → fails", () => {
    const failures = checkCriteria(overview({ marketCap: 500_000_000 }), { minMarketCap: 1_000_000_000 });
    expect(failures.map((f) => f.criterion)).toContain("minMarketCap");
  });

  test("sector match is case-insensitive", () => {
    const failures = checkCriteria(overview({ sector: "TECHNOLOGY" }), { sector: "technology" });
    expect(failures).toEqual([]);
  });

  test("multiple violations are all reported", () => {
    const failures = checkCriteria(overview({ sector: "Energy", peRatio: 40 }), {
      sector: "Technology",
      maxPe: 30,
    });
    expect(failures.map((f) => f.criterion).sort()).toEqual(["maxPe", "sector"]);
  });
});
