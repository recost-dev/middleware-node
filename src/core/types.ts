/**
 * Core type definitions for @ecoapi/node middleware.
 * All concrete implementations will be built on top of these contracts.
 */

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Provider {
  /** Unique identifier for this provider (e.g. "openai", "anthropic"). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Optional metadata bag for provider-specific configuration. */
  readonly meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Request / Response context
// ---------------------------------------------------------------------------

export interface EcoRequest {
  providerId: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  meta?: Record<string, unknown>;
}

export interface EcoResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interceptor
// ---------------------------------------------------------------------------

export type NextFn<T> = (ctx: T) => Promise<T>;

export interface RequestInterceptor {
  onRequest(req: EcoRequest, next: NextFn<EcoRequest>): Promise<EcoRequest>;
}

export interface ResponseInterceptor {
  onResponse(res: EcoResponse, next: NextFn<EcoResponse>): Promise<EcoResponse>;
}

export type Interceptor = RequestInterceptor | ResponseInterceptor;

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export interface AggregatorResult<T = unknown> {
  providerId: string;
  data: T;
  error?: Error;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportOptions {
  timeoutMs?: number;
  retries?: number;
}

export interface Transport {
  send(req: EcoRequest, opts?: TransportOptions): Promise<EcoResponse>;
}
