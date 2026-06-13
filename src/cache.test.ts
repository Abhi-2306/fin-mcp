/** Unit tests for the TTL cache: hit/miss, expiry, and single-flight coalescing. */

import { describe, expect, test } from "bun:test";
import { TtlCache } from "./cache.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("TtlCache", () => {
  test("second get within TTL is a hit → fetcher NOT called again", async () => {
    const cache = new TtlCache();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "value";
    };

    expect(await cache.getOrFetch("k", 10_000, fetcher)).toBe("value");
    expect(await cache.getOrFetch("k", 10_000, fetcher)).toBe("value");

    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  test("after TTL expiry → miss, fetcher called again", async () => {
    const cache = new TtlCache();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return calls;
    };

    await cache.getOrFetch("k", 5, fetcher); // 5ms TTL
    await sleep(20); // let it expire
    await cache.getOrFetch("k", 5, fetcher);

    expect(calls).toBe(2);
    expect(cache.stats().misses).toBe(2);
  });

  test("two concurrent gets for the same key → fetcher called exactly ONCE (single-flight)", async () => {
    const cache = new TtlCache();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await sleep(20); // still in flight when the second call arrives
      return "shared";
    };

    const [a, b] = await Promise.all([
      cache.getOrFetch("k", 10_000, fetcher),
      cache.getOrFetch("k", 10_000, fetcher),
    ]);

    expect(a).toBe("shared");
    expect(b).toBe("shared");
    expect(calls).toBe(1);
  });
});
