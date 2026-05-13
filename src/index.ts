/**
 * @recost-dev/node — public API surface.
 * Re-export everything consumers need. Only add exports here when something is ready.
 */

// Core types
export type {
  RawEvent,
  MetricEntry,
  WindowSummary,
  ProviderDef,
  RecostConfig,
  TransportMode,
  FlushStatus,
} from "./core/types.js";

// Typed error classes (runtime values — separate export from the type-only block above)
export {
  RecostError,
  RecostAuthError,
  RecostFatalAuthError,
} from "./core/types.js";

// Top-level init
export { init } from "./init.js";
export type { RecostHandle } from "./init.js";

// Core classes (for advanced / direct usage)
export { ProviderRegistry, BUILTIN_PROVIDERS } from "./core/provider-registry.js";
export { install, uninstall, isInstalled } from "./core/interceptor.js";
export type { EventCallback } from "./core/interceptor.js";
export { Aggregator, MAX_BUCKETS } from "./core/aggregator.js";
export { Transport } from "./core/transport.js";

// Framework adapters
export { createExpressMiddleware } from "./frameworks/express.js";
export { createFastifyPlugin } from "./frameworks/fastify.js";
