/** Unit tests for the concurrency limiter and retry/backoff helper. */

import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter, withRetry } from "./limiter.ts";
import { ProviderError } from "./provider.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("ConcurrencyLimiter", () => {
  test("max 2: never runs more than 2 tasks simultaneously (5 queued)", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;

    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
    };

    await Promise.all(Array.from({ length: 5 }, () => limiter.run(task)));

    expect(peak).toBe(2); // reaches the cap...
    expect(peak).toBeLessThanOrEqual(2); // ...but never exceeds it
  });
});

describe("withRetry", () => {
  // Tiny backoff keeps tests fast while exercising the same retry logic.
  const fast = { backoffMs: [1, 1, 1] };

  test("retries a rate_limit error and succeeds on a later attempt", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new ProviderError("slow down", "rate_limit");
      return "ok";
    }, fast);

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("does NOT retry bad_ticker → throws immediately after one attempt", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new ProviderError("no such ticker", "bad_ticker");
      }, fast),
    ).rejects.toThrow("no such ticker");

    expect(attempts).toBe(1);
  });

  test("throws after exhausting max attempts (1 initial + 3 retries)", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new ProviderError("network down", "network");
      }, fast),
    ).rejects.toThrow("network down");

    expect(attempts).toBe(4);
  });
});
