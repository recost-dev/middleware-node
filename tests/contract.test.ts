/**
 * Cross-SDK payload contract test.
 *
 * Build a WindowSummary the same way init.ts does (Aggregator.flush()),
 * serialize it to JSON, then assert the exact set of top-level fields and
 * per-MetricEntry fields the cloud API expects. The matching test in
 * middleware-python (tests/test_contract.py) asserts the identical schema.
 *
 * If anyone renames or re-units a field on either side without updating both
 * SDKs, one of these tests fails — that's the whole point.
 *
 * Note on the original parity brief: the brief listed the asserted fields in
 * snake_case (`total_latency_ms`, `estimated_cost_cents`, ...) and a flat
 * `timestamp`. The wire format both SDKs actually produce — and that the
 * ingest API accepts — is camelCase nested under `metrics[]`, with
 * `windowStart` / `windowEnd` (ISO-8601) instead of a single timestamp.
 * This test therefore asserts the *real* shape, but covers every field the
 * brief mentioned (`provider`, `endpoint`, `method`, `totalLatencyMs`,
 * `estimatedCostCents`, plus the window timestamps) with the correct types
 * and units.
 */

import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/core/aggregator.js";
import type { RawEvent, WindowSummary } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Schema constants — keep in sync with tests/test_contract.py
// ---------------------------------------------------------------------------

const EXPECTED_TOP_LEVEL_KEYS = [
  "projectId",
  "environment",
  "sdkLanguage",
  "sdkVersion",
  "windowStart",
  "windowEnd",
  "metrics",
].sort();

const EXPECTED_METRIC_KEYS = [
  "provider",
  "endpoint",
  "method",
  "requestCount",
  "errorCount",
  "totalLatencyMs",
  "p50LatencyMs",
  "p95LatencyMs",
  "totalRequestBytes",
  "totalResponseBytes",
  "estimatedCostCents",
].sort();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    timestamp: "2026-04-21T12:00:00.000Z",
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com",
    path: "/v1/chat/completions",
    statusCode: 200,
    latencyMs: 120,
    requestBytes: 100,
    responseBytes: 500,
    provider: "openai",
    endpointCategory: "chat_completions",
    error: false,
    ...overrides,
  };
}

function buildFlushPayload(): WindowSummary {
  // Build the payload the same way init.ts does: Aggregator.flush() →
  // WindowSummary → JSON.stringify on the wire.
  const aggregator = new Aggregator({
    projectId: "proj-contract",
    environment: "test",
    sdkVersion: "0.1.0",
  });
  aggregator.ingest(makeRawEvent({ latencyMs: 100 }), 0.5);
  aggregator.ingest(makeRawEvent({ latencyMs: 300 }), 0.5);
  aggregator.ingest(makeRawEvent({ method: "GET", error: true, statusCode: 500 }), 0);

  const summary = aggregator.flush();
  if (summary === null) throw new Error("aggregator.flush() returned null");
  return summary;
}

// ---------------------------------------------------------------------------
// Top-level WindowSummary contract
// ---------------------------------------------------------------------------

describe("contract — WindowSummary top-level", () => {
  it("has exactly the documented top-level fields, no more, no less", () => {
    const summary = buildFlushPayload();
    const onWire = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;

    expect(Object.keys(onWire).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
  });

  it("uses ISO-8601 strings for windowStart and windowEnd", () => {
    const summary = buildFlushPayload();
    expect(typeof summary.windowStart).toBe("string");
    expect(typeof summary.windowEnd).toBe("string");
    // Must round-trip through Date — guards against accidentally emitting
    // unix-ms numbers, which the API would reject.
    expect(Number.isFinite(Date.parse(summary.windowStart))).toBe(true);
    expect(Number.isFinite(Date.parse(summary.windowEnd))).toBe(true);
  });

  it("windowStart and windowEnd match the locked wire format (ms precision, UTC Z)", () => {
    const summary = buildFlushPayload();
    // The cross-SDK wire-format contract: ISO 8601, millisecond precision, UTC "Z".
    // Mirrors the assertion in middleware-python/tests/test_contract.py.
    const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(summary.windowStart).toMatch(ISO_MS_Z);
    expect(summary.windowEnd).toMatch(ISO_MS_Z);
  });

  it("identifies itself as the node SDK", () => {
    const summary = buildFlushPayload();
    expect(summary.sdkLanguage).toBe("node");
  });

  it("has a non-empty metrics array for non-empty windows", () => {
    const summary = buildFlushPayload();
    expect(Array.isArray(summary.metrics)).toBe(true);
    expect(summary.metrics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-MetricEntry contract — these are the fields the brief called out
// ---------------------------------------------------------------------------

describe("contract — MetricEntry shape", () => {
  it("each metric has exactly the documented keys, no more, no less", () => {
    const summary = buildFlushPayload();
    for (const metric of summary.metrics) {
      const onWire = JSON.parse(JSON.stringify(metric)) as Record<string, unknown>;
      expect(Object.keys(onWire).sort()).toEqual(EXPECTED_METRIC_KEYS);
    }
  });

  it("provider / endpoint / method are strings, method is uppercase", () => {
    const summary = buildFlushPayload();
    for (const metric of summary.metrics) {
      expect(typeof metric.provider).toBe("string");
      expect(typeof metric.endpoint).toBe("string");
      expect(typeof metric.method).toBe("string");
      expect(metric.method).toBe(metric.method.toUpperCase());
    }
  });

  it("totalLatencyMs is a non-negative integer (milliseconds)", () => {
    const summary = buildFlushPayload();
    for (const metric of summary.metrics) {
      expect(typeof metric.totalLatencyMs).toBe("number");
      expect(Number.isInteger(metric.totalLatencyMs)).toBe(true);
      expect(metric.totalLatencyMs).toBeGreaterThanOrEqual(0);
    }
    // Sanity: aggregator summed 100 + 300 for the POST bucket
    const post = summary.metrics.find((m) => m.method === "POST");
    expect(post?.totalLatencyMs).toBe(400);
  });

  it("estimatedCostCents is a non-negative number (cents, may be fractional)", () => {
    const summary = buildFlushPayload();
    for (const metric of summary.metrics) {
      expect(typeof metric.estimatedCostCents).toBe("number");
      expect(Number.isFinite(metric.estimatedCostCents)).toBe(true);
      expect(metric.estimatedCostCents).toBeGreaterThanOrEqual(0);
    }
    // Sanity: two POST events at 0.5¢ each = 1.0¢
    const post = summary.metrics.find((m) => m.method === "POST");
    expect(post?.estimatedCostCents).toBeCloseTo(1.0, 6);
  });

  it("counter fields are non-negative integers", () => {
    const summary = buildFlushPayload();
    for (const metric of summary.metrics) {
      for (const key of ["requestCount", "errorCount", "totalRequestBytes", "totalResponseBytes", "p50LatencyMs", "p95LatencyMs"] as const) {
        const v = metric[key];
        expect(typeof v).toBe("number");
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
