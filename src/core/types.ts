/**
 * Core type definitions for @recost-dev/node.
 * Every other module imports from here. No runtime code, no external imports.
 */

// ---------------------------------------------------------------------------
// RawEvent
// ---------------------------------------------------------------------------

/** A single intercepted outbound HTTP request. One fetch/http call = one RawEvent. */
export interface RawEvent {
  /** ISO 8601 timestamp of when the request was initiated. */
  timestamp: string;
  /** HTTP method in uppercase (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS). */
  method: string;
  /** Full request URL with query parameters stripped for privacy. */
  url: string;
  /** Hostname extracted from the URL; what the provider registry matches against. */
  host: string;
  /** URL path component, used for endpoint categorization. */
  path: string;
  /** HTTP response status code. 0 if the request failed before a response was received. */
  statusCode: number;
  /** Round-trip time in milliseconds. For streaming responses, time to first byte. */
  latencyMs: number;
  /** Size of the request body in bytes. 0 if no body. */
  requestBytes: number;
  /** Size of the response body in bytes. 0 if no body or request failed. */
  responseBytes: number;
  /** Matched provider name from the registry (e.g. "openai"). Null if unrecognized. */
  provider: string | null;
  /** Matched endpoint category (e.g. "chat_completions"). Null if unmatched. */
  endpointCategory: string | null;
  /** True if statusCode >= 400 or the request failed with a network error. */
  error: boolean;
}

// ---------------------------------------------------------------------------
// MetricEntry
// ---------------------------------------------------------------------------

/** Aggregated stats for one provider + endpoint + method group within a time window. */
export interface MetricEntry {
  /** Provider name. Events with null provider are grouped under "unknown". */
  provider: string;
  /** Endpoint path. Events with null endpointCategory use the raw path. */
  endpoint: string;
  /** HTTP method (e.g. "POST"). */
  method: string;
  /** Total number of requests in this group during the window. */
  requestCount: number;
  /** Number of requests where error was true. */
  errorCount: number;
  /** Sum of all latencyMs values. Divide by requestCount for average. */
  totalLatencyMs: number;
  /** Median latency across all requests in this group. */
  p50LatencyMs: number;
  /** 95th-percentile latency across all requests in this group. */
  p95LatencyMs: number;
  /** Sum of all requestBytes in this group. */
  totalRequestBytes: number;
  /** Sum of all responseBytes in this group. */
  totalResponseBytes: number;
  /** Estimated cost in cents for all requests in this group. 0 if no cost data. */
  estimatedCostCents: number;
}

// ---------------------------------------------------------------------------
// WindowSummary
// ---------------------------------------------------------------------------

/** What the aggregator produces on flush. Sent to the cloud API or local extension. */
export interface WindowSummary {
  /** ReCost project ID from config. */
  projectId: string;
  /** Environment tag (e.g. "development", "production") from config. */
  environment: string;
  /** Always "node" for this SDK. */
  sdkLanguage: string;
  /** Package version from package.json. */
  sdkVersion: string;
  /** ISO 8601 timestamp of the first event in this window. */
  windowStart: string;
  /** ISO 8601 timestamp of when the flush occurred. */
  windowEnd: string;
  /** One entry per unique provider + endpoint + method observed during the window. */
  metrics: MetricEntry[];
}

// ---------------------------------------------------------------------------
// ProviderDef
// ---------------------------------------------------------------------------

/** A single provider matching rule for the provider registry. */
export interface ProviderDef {
  /** Hostname to match: exact (e.g. "api.openai.com") or wildcard prefix (e.g. "*.amazonaws.com"). */
  hostPattern: string;
  /** Optional path prefix to narrow the match (e.g. "/v1/chat"). */
  pathPrefix?: string;
  /** Provider name to assign when this rule matches (e.g. "openai"). */
  provider: string;
  /** Endpoint category to assign (e.g. "chat_completions"). Raw path used if omitted. */
  endpointCategory?: string;
  /** Estimated cost per request in cents. Reported as 0 if omitted. */
  costPerRequestCents?: number;
}

// ---------------------------------------------------------------------------
// RecostConfig
// ---------------------------------------------------------------------------

/** Configuration passed to init() or a framework wrapper. All fields are optional. */
export interface RecostConfig {
  /** API key for api.recost.dev. If omitted, the SDK runs in local (VS Code) mode. */
  apiKey?: string;
  /** Project ID on api.recost.dev. Required when apiKey is set. */
  projectId?: string;
  /** Environment tag attached to all telemetry. Defaults to "development". */
  environment?: string;
  /** Milliseconds between automatic aggregator flushes. Defaults to 30000. */
  flushIntervalMs?: number;
  /** Trigger an early flush when this many raw events accumulate. Defaults to 100. */
  maxBatchSize?: number;
  /**
   * Maximum unique (provider, endpoint, method) triplets per window. Defaults to 2000.
   * Crossing this threshold mid-window triggers an early flush so the API does
   * not reject the payload with a 422.
   */
  maxBuckets?: number;
  /** Localhost port for the VS Code extension WebSocket in local mode. Defaults to 9847. */
  localPort?: number;
  /** Log detailed telemetry activity to stdout when true. Defaults to false. */
  debug?: boolean;
  /** Master kill switch. When false, init() returns without patching anything. Defaults to true. */
  enabled?: boolean;
  /** Additional provider definitions merged into the built-in registry with higher priority. */
  customProviders?: ProviderDef[];
  /** URL substrings that cause a matching request to be silently dropped. */
  excludePatterns?: string[];
  /** Cloud API base URL. Defaults to "https://api.recost.dev". */
  baseUrl?: string;
  /** Maximum retry attempts for failed cloud flushes before dropping the payload. Defaults to 3. */
  maxRetries?: number;
  /**
   * Maximum number of serialized WindowSummary payloads buffered in the local-mode
   * WebSocket queue while the VS Code extension is unreachable. When full, the
   * oldest payload is dropped to make room (FIFO eviction) and `onError` is
   * invoked exactly once per overflow episode — subsequent drops in the same
   * episode are silent. The flag resets when the queue successfully drains to
   * empty (extension reconnects). Defaults to 1000.
   */
  maxWsQueueSize?: number;
  /**
   * Milliseconds dispose() will wait for the final shutdown flush to complete
   * before giving up and closing the transport. Defaults to 3000.
   * Mirrors the Python SDK's shutdown_flush_timeout_ms.
   */
  shutdownFlushTimeoutMs?: number;
  /** Called when the SDK encounters an internal error. Silently swallowed if omitted. */
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// TransportMode
// ---------------------------------------------------------------------------

/**
 * The two transport modes the SDK operates in.
 * Determined automatically: "cloud" if apiKey is present, "local" otherwise.
 */
export type TransportMode = "local" | "cloud";

// ---------------------------------------------------------------------------
// FlushStatus
// ---------------------------------------------------------------------------

/** Outcome of the most recent flush, exposed on the recost handle. */
export interface FlushStatus {
  status: "ok" | "error";
  /** Number of metric entries (unique triplets) in the flushed window. */
  windowSize: number;
  /** Milliseconds since epoch when the flush completed. */
  timestamp: number;
}
