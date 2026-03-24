/**
 * init() — wires the interceptor, provider registry, aggregator, and transport together.
 * This is the primary entry point for SDK users.
 */

import type { RecostConfig } from "./core/types.js";
import { ProviderRegistry } from "./core/provider-registry.js";
import { install, uninstall } from "./core/interceptor.js";
import { Aggregator } from "./core/aggregator.js";
import { Transport } from "./core/transport.js";

/** Returned by init() to allow explicit teardown. */
export interface RecostHandle {
  /** Stop intercepting, flush remaining events, and close transport connections. */
  dispose(): void;
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
    const noop: RecostHandle = { dispose: () => {} };
    _handle = noop;
    return noop;
  }

  const registry = new ProviderRegistry(config.customProviders);
  const aggregator = new Aggregator({
    ...(config.projectId !== undefined && { projectId: config.projectId }),
    ...(config.environment !== undefined && { environment: config.environment }),
    sdkVersion: "0.1.0",
  });
  const transport = new Transport(config);
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
    flushAndSend().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (config.onError) config.onError(error);
      else if (debug) console.error("[recost] flush error:", error.message);
    });
  }, config.flushIntervalMs ?? 30_000);

  // Don't keep the Node process alive just for the flush interval
  if (typeof timer.unref === "function") timer.unref();

  const handle: RecostHandle = {
    dispose() {
      clearInterval(timer);
      uninstall();
      transport.dispose();
      if (_handle === handle) _handle = null;
    },
  };

  _handle = handle;
  return handle;
}
