/**
 * Tests for src/core/aggregator.ts
 */

import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/core/aggregator.js";
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

describe("Aggregator", () => {
  // 1
  it("flush() returns null when no events have been ingested", () => {
    const agg = new Aggregator();
    expect(agg.flush()).toBeNull();
  });

  // 2
  it("single event produces one MetricEntry with correct values", () => {
    const agg = new Aggregator({ projectId: "p1", environment: "test" });
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

  // 3
  it("multiple events in the same group produce correct aggregates", () => {
    const agg = new Aggregator();
    const latencies = [100, 200, 300, 400, 500];
    for (const ms of latencies) {
      agg.ingest(makeEvent({ latencyMs: ms, requestBytes: 10, responseBytes: 20 }), 1.0);
    }
    const summary = agg.flush()!;

    expect(summary.metrics).toHaveLength(1);
    const entry = summary.metrics[0]!;
    expect(entry.requestCount).toBe(5);
    expect(entry.estimatedCostCents).toBe(5.0);
    expect(entry.totalLatencyMs).toBe(1500);
    expect(entry.p50LatencyMs).toBe(300); // sorted[2] of [100,200,300,400,500]
    expect(entry.p95LatencyMs).toBe(500); // sorted[4] of 5 values
    expect(entry.totalRequestBytes).toBe(50);
    expect(entry.totalResponseBytes).toBe(100);
  });

  // 4
  it("events across different groups produce independent MetricEntries", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: "openai", endpointCategory: "chat_completions", method: "POST" }));
    agg.ingest(makeEvent({ provider: "openai", endpointCategory: "embeddings", method: "POST" }));
    agg.ingest(makeEvent({ provider: "stripe", endpointCategory: "charges", method: "POST" }));
    const summary = agg.flush()!;

    expect(summary.metrics).toHaveLength(3);
    for (const entry of summary.metrics) {
      expect(entry.requestCount).toBe(1);
    }
  });

  // 5
  it("counts errors correctly", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 10; i++) {
      agg.ingest(makeEvent({ error: i < 3, statusCode: i < 3 ? 500 : 200 }));
    }
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.requestCount).toBe(10);
    expect(entry.errorCount).toBe(3);
  });

  // 6
  it("null provider and endpointCategory fall back to 'unknown' and raw path", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: null, endpointCategory: null, path: "/api/internal" }));
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.provider).toBe("unknown");
    expect(entry.endpoint).toBe("/api/internal");
  });

  // 7
  it("flush resets state; second window is independent of first", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 5; i++) agg.ingest(makeEvent());
    agg.flush();

    expect(agg.size).toBe(0);
    expect(agg.bucketCount).toBe(0);

    for (let i = 0; i < 3; i++) agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.metrics[0]!.requestCount).toBe(3);
  });

  // 8
  it("windowStart matches the first event's timestamp, windowEnd is later", () => {
    const agg = new Aggregator();
    const t1 = "2026-03-10T00:00:00.000Z";
    agg.ingest(makeEvent({ timestamp: t1 }));
    agg.ingest(makeEvent({ timestamp: "2026-03-10T00:00:01.000Z" }));
    const summary = agg.flush()!;

    expect(summary.windowStart).toBe(t1);
    expect(new Date(summary.windowEnd).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
  });

  // 9
  it("size and bucketCount track correctly before and after flush", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: "openai", endpointCategory: "chat_completions" }));
    agg.ingest(makeEvent({ provider: "openai", endpointCategory: "chat_completions" }));
    agg.ingest(makeEvent({ provider: "openai", endpointCategory: "embeddings" }));
    agg.ingest(makeEvent({ provider: "stripe", endpointCategory: "charges" }));
    agg.ingest(makeEvent({ provider: "stripe", endpointCategory: "charges" }));

    expect(agg.size).toBe(5);
    expect(agg.bucketCount).toBe(3);

    agg.flush();
    expect(agg.size).toBe(0);
    expect(agg.bucketCount).toBe(0);
  });

  // 10
  it("percentile edge cases", () => {
    // 1 event
    const agg1 = new Aggregator();
    agg1.ingest(makeEvent({ latencyMs: 42 }));
    const e1 = agg1.flush()!.metrics[0]!;
    expect(e1.p50LatencyMs).toBe(42);
    expect(e1.p95LatencyMs).toBe(42);

    // 2 events [100, 900]
    const agg2 = new Aggregator();
    agg2.ingest(makeEvent({ latencyMs: 900 }));
    agg2.ingest(makeEvent({ latencyMs: 100 }));
    const e2 = agg2.flush()!.metrics[0]!;
    // ceil(2*0.5)-1 = 0 → sorted[0] = 100
    expect(e2.p50LatencyMs).toBe(100);
    // ceil(2*0.95)-1 = 1 → sorted[1] = 900
    expect(e2.p95LatencyMs).toBe(900);

    // 100 events with latencies 1..100
    const agg3 = new Aggregator();
    for (let i = 1; i <= 100; i++) agg3.ingest(makeEvent({ latencyMs: i }));
    const e3 = agg3.flush()!.metrics[0]!;
    // ceil(100*0.5)-1 = 49 → sorted[49] = 50
    expect(e3.p50LatencyMs).toBe(50);
    // ceil(100*0.95)-1 = 94 → sorted[94] = 95
    expect(e3.p95LatencyMs).toBe(95);
  });

  // 11
  it("costCents defaults to 0 when not provided", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const entry = agg.flush()!.metrics[0]!;
    expect(entry.estimatedCostCents).toBe(0);
  });

  // 12
  it("WindowSummary metadata comes from constructor config", () => {
    const agg = new Aggregator({ projectId: "proj_123", environment: "production", sdkVersion: "1.2.3" });
    agg.ingest(makeEvent());
    const summary = agg.flush()!;

    expect(summary.projectId).toBe("proj_123");
    expect(summary.environment).toBe("production");
    expect(summary.sdkVersion).toBe("1.2.3");
    expect(summary.sdkLanguage).toBe("node");
  });

  // 13
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
