/**
 * Aggregator — buffers RawEvents and produces a WindowSummary on flush.
 * Computes per-group statistics including p50/p95 latency percentiles.
 * No side effects, no async, no timers — the caller manages the flush schedule.
 */

import type { EcoAPIConfig, MetricEntry, RawEvent, WindowSummary } from "./types.js";

// Kept in sync with package.json version field.
const SDK_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GroupAccumulator {
  latencies: number[];
  requestCount: number;
  errorCount: number;
  totalLatencyMs: number;
  totalRequestBytes: number;
  totalResponseBytes: number;
  /** Cost per single request in cents, carried from the registry match. */
  costPerRequestCents: number;
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))]!;
}

// ---------------------------------------------------------------------------
// Aggregator class
// ---------------------------------------------------------------------------

/** Buffers RawEvents and compresses them into a WindowSummary on flush. */
export class Aggregator {
  private _buffer: Array<{ event: RawEvent; cost: number }> = [];
  private _windowStart: string | null = null;

  /**
   * Add one RawEvent to the current window buffer.
   * @param event  The event produced by the interceptor (already enriched by the registry).
   * @param costPerRequestCents  Cost hint from the registry for this event's endpoint.
   */
  ingest(event: RawEvent, costPerRequestCents = 0): void {
    if (this._windowStart === null) this._windowStart = event.timestamp;
    this._buffer.push({ event, cost: costPerRequestCents });
  }

  /**
   * Flush the current buffer into a WindowSummary and reset state.
   * Returns null if the buffer is empty.
   */
  flush(config: EcoAPIConfig): WindowSummary | null {
    if (this._buffer.length === 0) return null;

    const windowStart = this._windowStart ?? new Date().toISOString();
    const windowEnd = new Date().toISOString();

    // Group by provider + endpoint + method
    const groups = new Map<string, GroupAccumulator>();

    for (const { event, cost } of this._buffer) {
      const provider = event.provider ?? "unknown";
      const endpoint = event.endpointCategory ?? event.path;
      const key = `${provider}\0${endpoint}\0${event.method}`;

      let g = groups.get(key);
      if (g === undefined) {
        g = {
          latencies: [],
          requestCount: 0,
          errorCount: 0,
          totalLatencyMs: 0,
          totalRequestBytes: 0,
          totalResponseBytes: 0,
          costPerRequestCents: cost,
        };
        groups.set(key, g);
      }

      g.latencies.push(event.latencyMs);
      g.requestCount += 1;
      if (event.error) g.errorCount += 1;
      g.totalLatencyMs += event.latencyMs;
      g.totalRequestBytes += event.requestBytes;
      g.totalResponseBytes += event.responseBytes;
    }

    const metrics: MetricEntry[] = [];

    for (const [key, g] of groups) {
      const [provider, endpoint, method] = key.split("\0") as [string, string, string];
      g.latencies.sort((a, b) => a - b);

      metrics.push({
        provider,
        endpoint,
        method,
        requestCount: g.requestCount,
        errorCount: g.errorCount,
        totalLatencyMs: g.totalLatencyMs,
        p50LatencyMs: percentile(g.latencies, 0.5),
        p95LatencyMs: percentile(g.latencies, 0.95),
        totalRequestBytes: g.totalRequestBytes,
        totalResponseBytes: g.totalResponseBytes,
        estimatedCostCents: g.costPerRequestCents * g.requestCount,
      });
    }

    // Reset
    this._buffer = [];
    this._windowStart = null;

    return {
      projectId: config.projectId ?? "",
      environment: config.environment ?? "development",
      sdkLanguage: "node",
      sdkVersion: SDK_VERSION,
      windowStart,
      windowEnd,
      metrics,
    };
  }

  /** Number of events currently buffered (before the next flush). */
  get bufferSize(): number {
    return this._buffer.length;
  }
}
