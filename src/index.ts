/**
 * @ecoapi/node — public API surface.
 *
 * Re-export everything consumers need. Keep this file as the single
 * source of truth for what is considered public API.
 */

// Core types
export type {
  Provider,
  EcoRequest,
  EcoResponse,
  Interceptor,
  RequestInterceptor,
  ResponseInterceptor,
  NextFn,
  AggregatorResult,
  Transport,
  TransportOptions,
} from "./core/types.js";

// Core classes
export { ProviderRegistry } from "./core/provider-registry.js";
export { InterceptorChain } from "./core/interceptor.js";
export { Aggregator } from "./core/aggregator.js";
export { HttpTransport } from "./core/transport.js";

// Framework adapters
export { createExpressMiddleware } from "./frameworks/express.js";
export { createFastifyPlugin } from "./frameworks/fastify.js";
