/**
 * init() — wires the interceptor, provider registry, aggregator, and transport together.
 * This is the primary entry point for SDK users.
 */

import type { FlushStatus, RecostConfig } from "./core/types.js";
import { ProviderRegistry } from "./core/provider-registry.js";
import { install, uninstall } from "./core/interceptor.js";
import { Aggregator, MAX_BUCKETS } from "./core/aggregator.js";
import { Transport } from "./core/transport.js";
import { validateConfig } from "./core/validate-config.js";

/** Returned by init() to allow explicit teardown. */
export interface RecostHandle {
  /**
   * Stop intercepting, perform one final shutdown flush, then close transport
   * connections. The returned promise resolves once the final flush completes
   * or `shutdownFlushTimeoutMs` elapses (whichever comes first). It never
   * rejects — flush errors are routed through the configured `onError`.
   *
   * Awaiting is optional: callers that don't care about flush completion can
   * keep calling `dispose()` synchronously, but in long-running services or
   * test teardown you probably want to `await` so the in-flight POST isn't
   * cut off when the process exits.
   */
  dispose(): Promise<void>;
  /** Outcome of the most recent flush, or null if no flush has completed yet. */
  readonly lastFlushStatus: FlushStatus | null;
}

// Module-level handle so a second init() call disposes the first.
let _handle: RecostHandle | null = null;

/**
 * Initialize the ReCost SDK.
 *
 * - Patches `globalThis.fetch`, `http.request`, and `https.request`.
 * - Starts a flush interval that sends aggregated telemetry on the configured schedule.
 * - Returns a handle with a `dispose()` method for explicit cleanup.
 *
 * Calling `init()` a second time disposes the previous instance before re-initializing.
 * Set `config.enabled = false` (or `ECOAPI_ENABLED=false` in your startup code) to
 * disable all patching — useful in test environments.
 */
export function init(config: RecostConfig = {}): RecostHandle {
  // Dispose any running instance first
  _handle?.dispose();

  const enabled = config.enabled ?? true;
  if (!enabled) {
    const noop: RecostHandle = { dispose: async () => {}, lastFlushStatus: null };
    _handle = noop;
    return noop;
  }

  // Throws synchronously on invalid config so we never install the
  // interceptor, start the timer, or open a transport in a known-broken
  // state (issues #15, #18). Runs *after* the enabled gate so explicitly
  // disabled SDKs in tests don't have to satisfy production-mode rules.
  validateConfig(config);

  const maxBuckets = config.maxBuckets ?? MAX_BUCKETS;
  const registry = new ProviderRegistry(config.customProviders);
  const aggregator = new Aggregator({
    ...(config.environment !== undefined && { environment: config.environment }),
    sdkVersion: "0.1.0",
    maxBuckets,
  });
  const transport = new Transport({ ...config, maxBuckets });
  const debug = config.debug ?? false;
  const maxBatchSize = config.maxBatchSize ?? 100;

  // Build the set of URL substrings to exclude from tracking.
  // Always exclude the SDK's own transport endpoints to prevent self-instrumentation.
  const excludePatterns: string[] = [...(config.excludePatterns ?? [])];
  if (config.apiKey) {
    excludePatterns.push((config.baseUrl ?? "https://api.recost.dev").replace(/\/$/, ""));
  } else {
    excludePatterns.push(`127.0.0.1:${config.localPort ?? 9847}`);
    excludePatterns.push(`localhost:${config.localPort ?? 9847}`);
  }

  const flushAndSend = async (): Promise<void> => {
    const summary = aggregator.flush();
    if (!summary) return;
    if (debug) {
      console.log(
        `[recost] flush: ${summary.metrics.length} metric group(s), window ${summary.windowStart} → ${summary.windowEnd}`,
      );
    }
    await transport.send(summary);
  };

  install((event) => {
    // Drop excluded URLs
    if (excludePatterns.some((p) => event.url.includes(p) || event.host.includes(p))) return;

    // Enrich with provider/endpoint from the registry
    const match = registry.match(event.url);
    if (match !== null) {
      event.provider = match.provider;
      event.endpointCategory = match.endpointCategory;
    }

    if (debug) {
      console.log(
        `[recost] captured ${event.method} ${event.url} ${event.statusCode} (${event.latencyMs}ms)`,
      );
    }

    // If this event would push us past the bucket cap, flush the current
    // window first so it's preserved, then ingest into a fresh window.
    if (aggregator.wouldOverflow(event)) {
      flushAndSend().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (config.onError) config.onError(error);
        else if (debug) console.error("[recost] flush error:", error.message);
      });
    }

    aggregator.ingest(event, match?.costPerRequestCents ?? 0);

    // Trigger an early flush if the batch size threshold is reached
    if (aggregator.size >= maxBatchSize) {
      flushAndSend().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (config.onError) config.onError(error);
        else if (debug) console.error("[recost] flush error:", error.message);
      });
    }
  });

  const timer = setInterval(() => {
    // Outer try/catch guards against a sync throw from flushAndSend() itself
    // escaping the interval callback — otherwise the interval dies silently
    // for the rest of the process lifetime.
    try {
      flushAndSend().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (config.onError) config.onError(error);
        else if (debug) console.error("[recost] flush error:", error.message);
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (config.onError) config.onError(error);
      else if (debug) console.error("[recost] flush error:", error.message);
    }
  }, config.flushIntervalMs ?? 30_000);

  // Don't keep the Node process alive just for the flush interval
  if (typeof timer.unref === "function") timer.unref();

  const shutdownFlushTimeoutMs = config.shutdownFlushTimeoutMs ?? 3_000;
  let disposed = false;

  const handle: RecostHandle = {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Stop the periodic timer first so a tick can't race the shutdown
      // flush, then uninstall so post-dispose user requests aren't captured.
      clearInterval(timer);
      uninstall();

      // One final flush, bounded by shutdownFlushTimeoutMs. Without this the
      // window in progress at dispose time would be silently dropped — exactly
      // the data users care most about during graceful shutdown. We swallow
      // any flush error here because dispose() is documented as never
      // rejecting; errors still go through onError via flushAndSend's catch.
      try {
        await Promise.race([
          flushAndSend(),
          new Promise<void>((resolve) => setTimeout(resolve, shutdownFlushTimeoutMs)),
        ]);
      } catch {
        // flushAndSend already routes errors through onError
      }

      transport.dispose();
      if (_handle === handle) _handle = null;
    },
    get lastFlushStatus(): FlushStatus | null {
      return transport.lastFlushStatus;
    },
  };

  _handle = handle;
  return handle;
}
