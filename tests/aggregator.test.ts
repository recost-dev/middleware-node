/**
 * Tests for src/core/aggregator.ts
 */

import { describe, it, expect } from "vitest";
import { Aggregator, MAX_BUCKETS } from "../src/core/aggregator.js";
import type { RawEvent } from "../src/core/types.js";

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    timestamp: new Date().toISOString(),
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com",
    path: "/v1/chat/completions",
    statusCode: 200,
    latencyMs: 500,
    requestBytes: 1000,
    responseBytes: 2000,
    provider: "openai",
    endpointCategory: "chat_completions",
    error: false,
    ...overrides,
  };
}

describe("Aggregator — basic flush behavior", () => {
  it("flush returns null when empty", () => {
    const agg = new Aggregator();
    expect(agg.flush()).toBeNull();
  });

  it("flush returns a WindowSummary after one event", () => {
    const agg = new Aggregator({ environment: "test" });
    agg.ingest(makeEvent({ latencyMs: 250, requestBytes: 512, responseBytes: 1024 }), 2.0);
    const summary = agg.flush()!;

    expect(summary.metrics).toHaveLength(1);
    const entry = summary.metrics[0]!;
    expect(entry.requestCount).toBe(1);
    expect(entry.errorCount).toBe(0);
    expect(entry.totalLatencyMs).toBe(250);
    expect(entry.p50LatencyMs).toBe(250);
    expect(entry.p95LatencyMs).toBe(250);
    expect(entry.totalRequestBytes).toBe(512);
    expect(entry.totalResponseBytes).toBe(1024);
    expect(entry.estimatedCostCents).toBe(2.0);
  });

  it("flush resets state — second window is independent of first", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 5; i++) agg.ingest(makeEvent());
    agg.flush();

    expect(agg.size).toBe(0);
    expect(agg.bucketCount).toBe(0);

    for (let i = 0; i < 3; i++) agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.metrics[0]!.requestCount).toBe(3);
  });

  it("double flush — second call returns null", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    agg.flush();
    expect(agg.flush()).toBeNull();
  });
});

describe("Aggregator — aggregation", () => {
  it("groups events by provider+endpoint+method into separate MetricEntries", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: "openai",  endpointCategory: "chat_completions", method: "POST" }));
    agg.ingest(makeEvent({ provider: "openai",  endpointCategory: "embeddings",       method: "POST" }));
    agg.ingest(makeEvent({ provider: "stripe",  endpointCategory: "charges",          method: "POST" }));
    const summary = agg.flush()!;

    expect(summary.metrics).toHaveLength(3);
    for (const entry of summary.metrics) {
      expect(entry.requestCount).toBe(1);
    }
  });

  it("combines events in the same group — correct requestCount and totalLatencyMs", () => {
    const agg = new Aggregator();
    const latencies = [100, 200, 300, 400, 500];
    for (const ms of latencies) {
      agg.ingest(makeEvent({ latencyMs: ms, requestBytes: 10, responseBytes: 20 }), 1.0);
    }
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.requestCount).toBe(5);
    expect(entry.totalLatencyMs).toBe(1500);
    expect(entry.estimatedCostCents).toBe(5.0);
    expect(entry.totalRequestBytes).toBe(50);
    expect(entry.totalResponseBytes).toBe(100);
  });

  it("counts errors correctly", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 10; i++) {
      agg.ingest(makeEvent({ error: i < 3, statusCode: i < 3 ? 500 : 200 }));
    }
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.requestCount).toBe(10);
    expect(entry.errorCount).toBe(3);
  });

  it("sums bytes correctly across multiple events", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ requestBytes: 100, responseBytes: 400 }));
    agg.ingest(makeEvent({ requestBytes: 200, responseBytes: 500 }));
    agg.ingest(makeEvent({ requestBytes: 300, responseBytes: 600 }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.totalRequestBytes).toBe(600);
    expect(entry.totalResponseBytes).toBe(1500);
  });

  it("sums cost correctly", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 5; i++) agg.ingest(makeEvent(), 1.5);
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.estimatedCostCents).toBeCloseTo(7.5);
  });

  it("cost defaults to 0 when not provided", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.estimatedCostCents).toBe(0);
  });
});

describe("Aggregator — percentiles", () => {
  it("p50 and p95 with 1 event — both equal the single latency value", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ latencyMs: 42 }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.p50LatencyMs).toBe(42);
    expect(entry.p95LatencyMs).toBe(42);
  });

  it("p50 and p95 with 2 events [100, 900]", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ latencyMs: 900 }));
    agg.ingest(makeEvent({ latencyMs: 100 }));
    const entry = agg.flush()!.metrics[0]!;
    // Sorted: [100, 900]
    // p50: ceil(2*0.5)-1 = 0 → sorted[0] = 100
    expect(entry.p50LatencyMs).toBe(100);
    // p95: ceil(2*0.95)-1 = 1 → sorted[1] = 900
    expect(entry.p95LatencyMs).toBe(900);
  });

  it("p50 with 5 events [100,200,300,400,500] — should be 300", () => {
    const agg = new Aggregator();
    for (const ms of [100, 200, 300, 400, 500]) {
      agg.ingest(makeEvent({ latencyMs: ms }));
    }
    const entry = agg.flush()!.metrics[0]!;
    // ceil(5*0.5)-1 = 2 → sorted[2] = 300
    expect(entry.p50LatencyMs).toBe(300);
    // ceil(5*0.95)-1 = 4 → sorted[4] = 500
    expect(entry.p95LatencyMs).toBe(500);
  });

  it("p95 with 100 events (latencies 1..100) — should be 95", () => {
    const agg = new Aggregator();
    for (let i = 1; i <= 100; i++) agg.ingest(makeEvent({ latencyMs: i }));
    const entry = agg.flush()!.metrics[0]!;
    // ceil(100*0.5)-1 = 49 → sorted[49] = 50
    expect(entry.p50LatencyMs).toBe(50);
    // ceil(100*0.95)-1 = 94 → sorted[94] = 95
    expect(entry.p95LatencyMs).toBe(95);
  });

  it("p50 and p95 with identical latency values — both equal that value", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 10; i++) agg.ingest(makeEvent({ latencyMs: 42 }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.p50LatencyMs).toBe(42);
    expect(entry.p95LatencyMs).toBe(42);
  });
});

describe("Aggregator — null provider handling", () => {
  it("null provider becomes 'unknown'", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: null, endpointCategory: "something" }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.provider).toBe("unknown");
  });

  it("null endpointCategory uses raw path", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ endpointCategory: null, path: "/api/internal" }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.endpoint).toBe("/api/internal");
  });

  it("both null — provider is 'unknown', endpoint is raw path", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: null, endpointCategory: null, path: "/v1/unknown" }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.provider).toBe("unknown");
    expect(entry.endpoint).toBe("/v1/unknown");
  });
});

describe("Aggregator — window timestamps", () => {
  it("windowStart matches the first event's timestamp", () => {
    const agg = new Aggregator();
    const t1 = "2026-03-10T00:00:00.000Z";
    agg.ingest(makeEvent({ timestamp: t1 }));
    agg.ingest(makeEvent({ timestamp: "2026-03-10T00:00:01.000Z" }));
    const summary = agg.flush()!;
    expect(summary.windowStart).toBe(t1);
  });

  it("windowEnd is approximately now (within 2 seconds)", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const before = Date.now();
    const summary = agg.flush()!;
    const after = Date.now();
    const windowEndMs = new Date(summary.windowEnd).getTime();
    expect(windowEndMs).toBeGreaterThanOrEqual(before - 100);
    expect(windowEndMs).toBeLessThanOrEqual(after + 100);
  });

  it("windowEnd is later than windowStart", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ timestamp: "2020-01-01T00:00:00.000Z" }));
    const summary = agg.flush()!;
    expect(new Date(summary.windowEnd).getTime()).toBeGreaterThanOrEqual(
      new Date(summary.windowStart).getTime(),
    );
  });
});

describe("Aggregator — metadata", () => {
  it("WindowSummary includes constructor config values", () => {
    const agg = new Aggregator({
      environment: "production",
      sdkVersion: "1.2.3",
    });
    agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.environment).toBe("production");
    expect(summary.sdkVersion).toBe("1.2.3");
    expect(summary.sdkLanguage).toBe("node");
  });

  it("defaults: environment 'development', sdkVersion '0.0.0'", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.environment).toBe("development");
    expect(summary.sdkVersion).toBe("0.0.0");
  });
});

describe("Aggregator — size and bucketCount", () => {
  it("size tracks total ingested events", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    agg.ingest(makeEvent());
    agg.ingest(makeEvent());
    expect(agg.size).toBe(3);
  });

  it("bucketCount tracks unique (provider+endpoint+method) groups", () => {
    const agg = new Aggregator();
    // 2 events in group A
    agg.ingest(makeEvent({ provider: "openai",  endpointCategory: "chat_completions" }));
    agg.ingest(makeEvent({ provider: "openai",  endpointCategory: "chat_completions" }));
    // 3 events in group B
    agg.ingest(makeEvent({ provider: "stripe",  endpointCategory: "charges" }));
    agg.ingest(makeEvent({ provider: "stripe",  endpointCategory: "charges" }));
    agg.ingest(makeEvent({ provider: "stripe",  endpointCategory: "charges" }));
    expect(agg.size).toBe(5);
    expect(agg.bucketCount).toBe(2);
  });

  it("both reset to 0 after flush", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    agg.ingest(makeEvent());
    agg.flush();
    expect(agg.size).toBe(0);
    expect(agg.bucketCount).toBe(0);
  });

  it("size and bucketCount are 0 on a fresh instance", () => {
    const agg = new Aggregator();
    expect(agg.size).toBe(0);
    expect(agg.bucketCount).toBe(0);
  });

  it("MAX_BUCKETS constant is 2000", () => {
    expect(MAX_BUCKETS).toBe(2000);
  });

  it("large batch: 1000 events across 10 groups", () => {
    const agg = new Aggregator();
    const providers = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (let i = 0; i < 1000; i++) {
      const provider = providers[i % 10]!;
      agg.ingest(makeEvent({ provider, endpointCategory: provider }));
    }
    const summary = agg.flush()!;
    expect(summary.metrics).toHaveLength(10);
    for (const entry of summary.metrics) {
      expect(entry.requestCount).toBe(100);
    }
  });
});

describe("Aggregator — bucket overflow protection", () => {
  it("wouldOverflow returns false below the cap", () => {
    const agg = new Aggregator({ maxBuckets: 10 });
    for (let i = 0; i < 5; i++) {
      agg.ingest(makeEvent({ provider: `p${i}`, endpointCategory: `ep${i}` }));
    }
    expect(agg.wouldOverflow(makeEvent({ provider: "new", endpointCategory: "new" }))).toBe(false);
  });

  it("wouldOverflow returns false at the cap when key is already known", () => {
    const agg = new Aggregator({ maxBuckets: 3 });
    agg.ingest(makeEvent({ provider: "a", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "b", endpointCategory: "b" }));
    agg.ingest(makeEvent({ provider: "c", endpointCategory: "c" }));
    expect(agg.bucketCount).toBe(3);
    // Same triplet — no new bucket needed
    expect(agg.wouldOverflow(makeEvent({ provider: "a", endpointCategory: "a" }))).toBe(false);
  });

  it("wouldOverflow returns true at the cap when triplet is new", () => {
    const agg = new Aggregator({ maxBuckets: 3 });
    agg.ingest(makeEvent({ provider: "a", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "b", endpointCategory: "b" }));
    agg.ingest(makeEvent({ provider: "c", endpointCategory: "c" }));
    expect(agg.wouldOverflow(makeEvent({ provider: "d", endpointCategory: "d" }))).toBe(true);
  });

  it("maxBuckets getter reflects configured value", () => {
    expect(new Aggregator({ maxBuckets: 500 }).maxBuckets).toBe(500);
    expect(new Aggregator().maxBuckets).toBe(MAX_BUCKETS);
  });

  it("default cap is 2000 — wouldOverflow fires at the 2001st unique triplet", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 2000; i++) {
      agg.ingest(makeEvent({ provider: `p${i}`, endpointCategory: `ep${i}` }));
    }
    expect(agg.bucketCount).toBe(2000);
    const overflowEvent = makeEvent({ provider: "p2000", endpointCategory: "ep2000" });
    expect(agg.wouldOverflow(overflowEvent)).toBe(true);
  });
});

describe("Aggregator — soft cap (ingest-time)", () => {
  it("at cap, an event with a new key is redirected to a per-provider _overflow bucket", () => {
    const agg = new Aggregator({ maxBuckets: 3 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "c" }));
    expect(agg.bucketCount).toBe(3);

    // This is event #4 with a new (provider, endpoint, method) triplet — at cap.
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "d", latencyMs: 999, requestBytes: 7, responseBytes: 11 }), 1.5);

    // A new _overflow bucket is created — bucketCount goes to 4. The cap is
    // soft: the redirect bucket is allowed to exceed the limit by exactly 1
    // per (provider, method) — counts stay bounded, attribution preserved.
    expect(agg.bucketCount).toBe(4);
    expect(agg.overflowCount).toBe(1);

    const summary = agg.flush()!;
    const overflow = summary.metrics.find((m) => m.endpoint === "_overflow" && m.provider === "p");
    expect(overflow).toBeDefined();
    expect(overflow!.requestCount).toBe(1);
    expect(overflow!.totalLatencyMs).toBe(999);
    expect(overflow!.totalRequestBytes).toBe(7);
    expect(overflow!.totalResponseBytes).toBe(11);
    expect(overflow!.estimatedCostCents).toBeCloseTo(1.5);
  });

  it("at cap, an event matching an EXISTING bucket key still ingests normally", () => {
    const agg = new Aggregator({ maxBuckets: 3 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "c" }));
    expect(agg.bucketCount).toBe(3);

    // Same triplet as the first event — no new bucket needed, no overflow.
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    expect(agg.bucketCount).toBe(3);
    expect(agg.overflowCount).toBe(0);

    const summary = agg.flush()!;
    const bucketA = summary.metrics.find((m) => m.endpoint === "a")!;
    expect(bucketA.requestCount).toBe(2);
  });

  it("multiple over-cap events accumulate into one _overflow bucket per (provider, method)", () => {
    const agg = new Aggregator({ maxBuckets: 2 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a", method: "GET" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b", method: "GET" }));

    // 5 over-cap events, all with the same (provider, method) but different
    // endpoints — they all collapse into a single (p, _overflow, GET) bucket.
    for (let i = 0; i < 5; i++) {
      agg.ingest(makeEvent({ provider: "p", endpointCategory: `new-${i}`, method: "GET", latencyMs: 100 }), 0.5);
    }

    expect(agg.bucketCount).toBe(3); // 2 original + 1 overflow
    expect(agg.overflowCount).toBe(5);

    const summary = agg.flush()!;
    const overflow = summary.metrics.find((m) => m.endpoint === "_overflow")!;
    expect(overflow.requestCount).toBe(5);
    expect(overflow.totalLatencyMs).toBe(500);
    expect(overflow.estimatedCostCents).toBeCloseTo(2.5);
  });

  it("overflowCount is exposed via getter and resets to 0 on flush", () => {
    const agg = new Aggregator({ maxBuckets: 1 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b" })); // overflow #1
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "c" })); // overflow #2 (same _overflow bucket, but still counted)
    expect(agg.overflowCount).toBe(2);

    agg.flush();
    expect(agg.overflowCount).toBe(0);
  });
});
