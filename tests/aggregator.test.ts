/**
 * Tests for src/core/aggregator.ts
 */

import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/core/aggregator.js";
import type { RawEvent } from "../src/core/types.js";

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    timestamp: new Date().toISOString(),
    method: "GET",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com",
    path: "/v1/chat/completions",
    statusCode: 200,
    latencyMs: 100,
    requestBytes: 0,
    responseBytes: 512,
    provider: "openai",
    endpointCategory: "chat_completions",
    error: false,
    ...overrides,
  };
}

const BASE_CONFIG = { projectId: "proj-1", environment: "test" };

describe("Aggregator", () => {
  it("flush() returns null when buffer is empty", () => {
    const agg = new Aggregator();
    expect(agg.flush(BASE_CONFIG)).toBeNull();
  });

  it("bufferSize reflects ingested events", () => {
    const agg = new Aggregator();
    expect(agg.bufferSize).toBe(0);
    agg.ingest(makeEvent());
    expect(agg.bufferSize).toBe(1);
    agg.ingest(makeEvent());
    expect(agg.bufferSize).toBe(2);
  });

  it("flush() resets the buffer to 0", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    agg.flush(BASE_CONFIG);
    expect(agg.bufferSize).toBe(0);
  });

  it("flush() returns null on second call after empty flush", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    agg.flush(BASE_CONFIG);
    expect(agg.flush(BASE_CONFIG)).toBeNull();
  });

  it("WindowSummary has correct top-level fields", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const summary = agg.flush(BASE_CONFIG)!;
    expect(summary.projectId).toBe("proj-1");
    expect(summary.environment).toBe("test");
    expect(summary.sdkLanguage).toBe("node");
    expect(typeof summary.sdkVersion).toBe("string");
    expect(summary.windowStart).toBeTruthy();
    expect(summary.windowEnd).toBeTruthy();
  });

  it("groups events by provider + endpoint + method", () => {
    const agg = new Aggregator();
    // Two events in the same group
    agg.ingest(makeEvent({ latencyMs: 100 }));
    agg.ingest(makeEvent({ latencyMs: 200 }));
    // One event in a different group (different endpoint)
    agg.ingest(makeEvent({ path: "/v1/embeddings", endpointCategory: "embeddings", latencyMs: 50 }));

    const summary = agg.flush(BASE_CONFIG)!;
    expect(summary.metrics).toHaveLength(2);
  });

  it("MetricEntry counts are correct", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ latencyMs: 100, error: false }));
    agg.ingest(makeEvent({ latencyMs: 200, error: true, statusCode: 500 }));
    agg.ingest(makeEvent({ latencyMs: 150, error: false }));

    const summary = agg.flush(BASE_CONFIG)!;
    const entry = summary.metrics[0]!;
    expect(entry.requestCount).toBe(3);
    expect(entry.errorCount).toBe(1);
    expect(entry.totalLatencyMs).toBe(450);
    expect(entry.totalResponseBytes).toBe(512 * 3);
  });

  it("p50LatencyMs is the median", () => {
    const agg = new Aggregator();
    // Latencies: 10, 50, 90 → sorted [10, 50, 90] → median = 50
    for (const ms of [90, 10, 50]) {
      agg.ingest(makeEvent({ latencyMs: ms }));
    }
    const entry = agg.flush(BASE_CONFIG)!.metrics[0]!;
    expect(entry.p50LatencyMs).toBe(50);
  });

  it("p95LatencyMs approximates the 95th percentile", () => {
    const agg = new Aggregator();
    // 20 events with latencies 1..20
    for (let i = 1; i <= 20; i++) agg.ingest(makeEvent({ latencyMs: i }));
    const entry = agg.flush(BASE_CONFIG)!.metrics[0]!;
    // ceil(0.95 * 20) - 1 = 18 → sorted[18] = 19
    expect(entry.p95LatencyMs).toBe(19);
  });

  it("estimatedCostCents = costPerRequestCents * requestCount", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent(), 2.0);
    agg.ingest(makeEvent(), 2.0);
    agg.ingest(makeEvent(), 2.0);
    const entry = agg.flush(BASE_CONFIG)!.metrics[0]!;
    expect(entry.estimatedCostCents).toBe(6.0);
  });

  it("events with null provider are grouped under 'unknown'", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ provider: null, endpointCategory: null }));
    const entry = agg.flush(BASE_CONFIG)!.metrics[0]!;
    expect(entry.provider).toBe("unknown");
  });

  it("events with null endpointCategory use raw path as endpoint", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent({ endpointCategory: null, path: "/some/internal/path" }));
    const entry = agg.flush(BASE_CONFIG)!.metrics[0]!;
    expect(entry.endpoint).toBe("/some/internal/path");
  });

  it("environment defaults to 'development'", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const summary = agg.flush({})!;
    expect(summary.environment).toBe("development");
  });

  it("windowStart is the timestamp of the first ingested event", () => {
    const agg = new Aggregator();
    const first = "2026-01-01T00:00:00.000Z";
    agg.ingest(makeEvent({ timestamp: first }));
    agg.ingest(makeEvent({ timestamp: "2026-01-01T00:01:00.000Z" }));
    const summary = agg.flush(BASE_CONFIG)!;
    expect(summary.windowStart).toBe(first);
  });
});
