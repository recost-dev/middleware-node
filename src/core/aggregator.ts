/**
 * Aggregator — collects RawEvents into time-windowed buckets and produces
 * a compressed WindowSummary on flush.
 *
 * Pure data structure: no I/O, no timers, no side effects.
 * The caller (init.ts) owns the flush schedule and passes cost hints.
 */

import type { MetricEntry, RawEvent, WindowSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Internal bucket structure
// ---------------------------------------------------------------------------

interface Bucket {
  provider: string;
  endpoint: string;
  method: string;
  requestCount: number;
  errorCount: number;
  /** Individual latency values retained for p50/p95 computation at flush time. */
  latencies: number[];
  totalRequestBytes: number;
  totalResponseBytes: number;
  estimatedCostCents: number;
}

// ---------------------------------------------------------------------------
// Percentile helper (private)
// ---------------------------------------------------------------------------

function computePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil(sortedValues.length * p) - 1;
  return sortedValues[Math.max(0, Math.min(idx, sortedValues.length - 1))]!;
}

// ---------------------------------------------------------------------------
// Aggregator class
// ---------------------------------------------------------------------------

/** Configuration passed to the Aggregator constructor. */
export interface AggregatorConfig {
  /** Attached to every WindowSummary. Defaults to "". */
  projectId?: string;
  /** Attached to every WindowSummary. Defaults to "development". */
  environment?: string;
  /** SDK package version string. Defaults to "0.0.0". */
  sdkVersion?: string;
}

/**
 * Collects RawEvents into per-(provider, endpoint, method) buckets and
 * compresses them into a WindowSummary on flush.
 *
 * Ingest is O(1): only counters are updated and latency values are appended.
 * All sorting and percentile computation is deferred to flush().
 */
export class Aggregator {
  private readonly _projectId: string;
  private readonly _environment: string;
  private readonly _sdkVersion: string;

  private _buckets = new Map<string, Bucket>();
  private _windowStart: string | null = null;
  private _size = 0;

  constructor(config: AggregatorConfig = {}) {
    this._projectId = config.projectId ?? "";
    this._environment = config.environment ?? "development";
    this._sdkVersion = config.sdkVersion ?? "0.0.0";
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Add one RawEvent to the current window.
   * Called on every intercepted HTTP request — must be fast.
   *
   * @param event     The intercepted and registry-enriched event.
   * @param costCents Cost per request in cents from the registry match. Defaults to 0.
   */
  ingest(event: RawEvent, costCents = 0): void {
    if (this._windowStart === null) {
      this._windowStart = event.timestamp;
    }

    const provider = event.provider ?? "unknown";
    const endpoint = event.endpointCategory ?? event.path;
    const key = `${provider}::${endpoint}::${event.method}`;

    let bucket = this._buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        provider,
        endpoint,
        method: event.method,
        requestCount: 0,
        errorCount: 0,
        latencies: [],
        totalRequestBytes: 0,
        totalResponseBytes: 0,
        estimatedCostCents: 0,
      };
      this._buckets.set(key, bucket);
    }

    bucket.requestCount += 1;
    if (event.error) bucket.errorCount += 1;
    bucket.latencies.push(event.latencyMs);
    bucket.totalRequestBytes += event.requestBytes;
    bucket.totalResponseBytes += event.responseBytes;
    bucket.estimatedCostCents += costCents;

    this._size += 1;
  }

  /**
   * Compress the current window into a WindowSummary and reset state.
   * Returns null if no events have been ingested since the last flush.
   */
  flush(): WindowSummary | null {
    if (this._buckets.size === 0) return null;

    const windowStart = this._windowStart ?? new Date().toISOString();
    const windowEnd = new Date().toISOString();

    const metrics: MetricEntry[] = [];

    for (const bucket of this._buckets.values()) {
      const sorted = bucket.latencies.slice().sort((a, b) => a - b);
      const totalLatencyMs = sorted.reduce((s, v) => s + v, 0);

      metrics.push({
        provider: bucket.provider,
        endpoint: bucket.endpoint,
        method: bucket.method,
        requestCount: bucket.requestCount,
        errorCount: bucket.errorCount,
        totalLatencyMs,
        p50LatencyMs: computePercentile(sorted, 0.5),
        p95LatencyMs: computePercentile(sorted, 0.95),
        totalRequestBytes: bucket.totalRequestBytes,
        totalResponseBytes: bucket.totalResponseBytes,
        estimatedCostCents: bucket.estimatedCostCents,
      });
    }

    // Reset
    this._buckets = new Map();
    this._windowStart = null;
    this._size = 0;

    return {
      projectId: this._projectId,
      environment: this._environment,
      sdkLanguage: "node",
      sdkVersion: this._sdkVersion,
      windowStart,
      windowEnd,
      metrics,
    };
  }

  /** Total events ingested since the last flush. */
  get size(): number {
    return this._size;
  }

  /** Number of unique provider + endpoint + method groups in the current window. */
  get bucketCount(): number {
    return this._buckets.size;
  }
}
