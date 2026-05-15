/**
 * Aggregator — collects RawEvents into time-windowed buckets and produces
 * a compressed WindowSummary on flush.
 *
 * Pure data structure: no I/O, no timers, no side effects.
 * The caller (init.ts) owns the flush schedule and passes cost hints.
 */

import type { MetricEntry, RawEvent, WindowSummary } from "./types.js";
import { isoNow } from "./time.js";

/**
 * Maximum unique (provider, endpoint, method) triplets per window.
 * Matches the ingest API's 422 threshold — crossing this mid-window triggers
 * an early flush so the current window is preserved instead of dropped.
 */
export const MAX_BUCKETS = 2000;

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
  /** Attached to every WindowSummary. Defaults to "development". */
  environment?: string;
  /** SDK package version string. Defaults to "0.0.0". */
  sdkVersion?: string;
  /** Maximum unique triplets per window. Defaults to MAX_BUCKETS (2000). */
  maxBuckets?: number;
}

/**
 * Collects RawEvents into per-(provider, endpoint, method) buckets and
 * compresses them into a WindowSummary on flush.
 *
 * Ingest is O(1): only counters are updated and latency values are appended.
 * All sorting and percentile computation is deferred to flush().
 */
export class Aggregator {
  private readonly _environment: string;
  private readonly _sdkVersion: string;
  private readonly _maxBuckets: number;

  private _buckets = new Map<string, Bucket>();
  private _windowStart: string | null = null;
  private _size = 0;
  private _overflowCount = 0;

  constructor(config: AggregatorConfig = {}) {
    this._environment = config.environment ?? "development";
    this._sdkVersion = config.sdkVersion ?? "0.0.0";
    this._maxBuckets = config.maxBuckets ?? MAX_BUCKETS;
  }

  /** Build the bucket key for an event — kept consistent with ingest(). */
  private _keyFor(event: RawEvent): string {
    const provider = event.provider ?? "unknown";
    const endpoint = event.endpointCategory ?? event.path;
    return `${provider}::${endpoint}::${event.method}`;
  }

  /**
   * Early-flush hint: true if ingesting this event would allocate a new bucket
   * AND the current window is already at `maxBuckets` capacity. Callers may
   * trigger an early flush to preserve the window before adding more events.
   *
   * Note: this is a hint, not a guarantee. Even without a flush, `ingest()`
   * itself synchronously enforces the cap by redirecting new keys into a
   * per-provider `_overflow` bucket — so cardinality stays bounded even when
   * the caller misses the hint or hits an async gap before flushing.
   */
  wouldOverflow(event: RawEvent): boolean {
    if (this._buckets.size < this._maxBuckets) return false;
    return !this._buckets.has(this._keyFor(event));
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
    let endpoint = event.endpointCategory ?? event.path;
    let key = this._keyFor(event);

    // Soft cap enforced synchronously: if we're at the bucket limit AND this
    // event would create a new bucket, redirect into a per-provider _overflow
    // bucket. Counts / latencies / bytes / cost are still accumulated — only
    // endpoint cardinality is bounded. `wouldOverflow()` remains the early-
    // flush hint, but the async gap between hint and flush in init.ts is now
    // closed here.
    if (this._buckets.size >= this._maxBuckets && !this._buckets.has(key)) {
      endpoint = "_overflow";
      key = `${provider}::_overflow::${event.method}`;
      this._overflowCount += 1;
    }

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

    const windowStart = this._windowStart ?? isoNow();
    const windowEnd = isoNow();

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
    this._overflowCount = 0;

    return {
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

  /** Configured maximum buckets per window. */
  get maxBuckets(): number {
    return this._maxBuckets;
  }

  /**
   * Number of events redirected into a `_overflow` bucket since the last flush
   * because the bucket cap was reached. Resets to 0 on every `flush()`.
   */
  get overflowCount(): number {
    return this._overflowCount;
  }
}
