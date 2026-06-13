/**
 * Unit tests for the Alpha Vantage provider: the `num()` parser and the
 * error-classification logic. `global.fetch` is mocked throughout — no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AlphaVantageProvider, num } from "./alphavantage.ts";
import { ProviderError } from "./provider.ts";

// The provider calls requireApiKey(); set a dummy so it never exits the runner.
// (No real request is ever made — fetch is mocked in every test below.)
process.env.ALPHAVANTAGE_API_KEY = "TEST_KEY_NOT_REAL";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/** Make `fetch` resolve to a JSON body with the given HTTP status. */
function mockJson(body: unknown, init: ResponseInit = { status: 200 }): void {
  global.fetch = (async () => new Response(JSON.stringify(body), init)) as unknown as typeof fetch;
}

describe("num()", () => {
  test('"295.63" → 295.63', () => expect(num("295.63")).toBe(295.63));
  test('"None" → null', () => expect(num("None")).toBeNull());
  test('"-" → null', () => expect(num("-")).toBeNull());
  test('"" → null', () => expect(num("")).toBeNull());
  test("null → null", () => expect(num(null)).toBeNull());
  test("undefined → null", () => expect(num(undefined)).toBeNull());
  test('"abc" → null (NaN guard)', () => expect(num("abc")).toBeNull());
  test('"42" → 42 (valid integer string)', () => expect(num("42")).toBe(42));
});

describe("error classification", () => {
  const provider = new AlphaVantageProvider();

  /** Run `fn`, expect it to throw a ProviderError, and return its `kind`. */
  async function kindOf(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ProviderError) return err.kind;
      throw err;
    }
    throw new Error("expected the call to throw a ProviderError");
  }

  test('body "Error Message" → bad_ticker', async () => {
    mockJson({ "Error Message": "Invalid API call" });
    expect(await kindOf(() => provider.getQuote("X"))).toBe("bad_ticker");
  });

  test('body "Note" → rate_limit', async () => {
    mockJson({ Note: "Thank you for using Alpha Vantage — calls per minute exceeded" });
    expect(await kindOf(() => provider.getQuote("X"))).toBe("rate_limit");
  });

  test('body "Information" matching rate-limit regex → rate_limit', async () => {
    mockJson({ Information: "Please consider spreading out your requests; the rate limit is 25 per day" });
    expect(await kindOf(() => provider.getQuote("X"))).toBe("rate_limit");
  });

  test('body "Information" NOT matching regex → unexpected', async () => {
    mockJson({ Information: "Thank you for using our service today" });
    expect(await kindOf(() => provider.getQuote("X"))).toBe("unexpected");
  });

  test("non-OK HTTP status → network", async () => {
    global.fetch = (async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
    expect(await kindOf(() => provider.getQuote("X"))).toBe("network");
  });

  test("non-JSON body → unexpected", async () => {
    global.fetch = (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;
    expect(await kindOf(() => provider.getQuote("X"))).toBe("unexpected");
  });

  test('{ "Global Quote": {} } (empty) → bad_ticker', async () => {
    mockJson({ "Global Quote": {} });
    expect(await kindOf(() => provider.getQuote("X"))).toBe("bad_ticker");
  });

  test("fetch itself throws (network failure) → network", async () => {
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await kindOf(() => provider.getQuote("X"))).toBe("network");
  });
});
