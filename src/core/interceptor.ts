/**
 * Interceptor — monkey-patches globalThis.fetch, http.request, https.request
 * (and their .get variants) to capture outbound request metadata as RawEvents.
 *
 * Singleton module. Only one set of patches can be active at a time.
 * The interceptor never reads or modifies request/response bodies.
 * Every wrapper is safety-wrapped so SDK errors can never break application code.
 */

import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import type { RawEvent } from "./types.js";
import { isoNow } from "./time.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Callback invoked for every captured outbound HTTP request. */
export type EventCallback = (event: RawEvent) => void;

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let _installed = false;
let _callback: EventCallback | null = null;

/** Set to true while inside the fetch wrapper to prevent http.request double-counting. */
let _inFetchWrapper = false;

// Original function references — restored on uninstall
let _originalFetch: typeof globalThis.fetch | null = null;
let _originalHttpRequest: typeof http.request | null = null;
let _originalHttpGet: typeof http.get | null = null;
let _originalHttpsRequest: typeof https.request | null = null;
let _originalHttpsGet: typeof https.get | null = null;

// ---------------------------------------------------------------------------
// URL extraction helper
// ---------------------------------------------------------------------------

interface ParsedUrl {
  url: string;   // origin + pathname only (query stripped)
  host: string;  // hostname without port
  path: string;  // pathname only
}

/**
 * Extracts a clean ParsedUrl from the various argument types accepted by
 * fetch (string | URL | Request) and http.request (string | URL | RequestOptions).
 * Returns null if parsing fails — callers should skip instrumentation in that case.
 */
function extractUrl(
  input: string | URL | http.RequestOptions | { url: string; method?: string },
  pathOverride?: string,
): ParsedUrl | null {
  try {
    let raw: string;

    if (typeof input === "string") {
      raw = input;
    } else if (input instanceof URL) {
      raw = input.toString();
    } else if (typeof input === "object" && input !== null && "url" in input && typeof (input as Request).url === "string") {
      // Request object
      raw = (input as Request).url;
    } else if (typeof input === "object" && input !== null) {
      // http.RequestOptions: reconstruct from parts
      const opts = input as http.RequestOptions;
      const protocol = opts.protocol ?? "http:";
      const hostRaw = opts.hostname ?? opts.host ?? "localhost";
      // Defensive: strip any port embedded in `opts.host` so it does not
      // collide with a separately-specified `opts.port` (e.g. "h:8080" + 8080
      // would otherwise produce an unparseable "h:8080:8080").
      const hostname = hostRaw.includes(":") ? hostRaw.slice(0, hostRaw.indexOf(":")) : hostRaw;
      const port = opts.port ? `:${opts.port}` : "";
      const rawPath = opts.path ?? "/";
      // Strip query string from path for privacy
      const pathname = rawPath.includes("?") ? rawPath.slice(0, rawPath.indexOf("?")) : rawPath;
      raw = `${protocol}//${hostname}${port}${pathname}`;
    } else {
      return null;
    }

    const parsed = new URL(raw);

    // Apply the path override last, after URL parsing. The override beats the
    // URL's own pathname — this is the http.request(URL, { path }) case where
    // the second-arg options.path is the caller's actual intent.
    if (pathOverride != null && pathOverride !== "") {
      const overrideStripped = pathOverride.includes("?")
        ? pathOverride.slice(0, pathOverride.indexOf("?"))
        : pathOverride;
      return {
        url: parsed.origin + overrideStripped,
        host: parsed.hostname,
        path: overrideStripped,
      };
    }

    return {
      url: parsed.origin + parsed.pathname,
      host: parsed.hostname,
      path: parsed.pathname,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request body size estimator (fetch)
// ---------------------------------------------------------------------------

async function estimateRequestBytes(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<number> {
  try {
    const body = init?.body;
    if (body != null) {
      if (typeof body === "string") return Buffer.byteLength(body);
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      // ReadableStream, FormData, URLSearchParams, Blob on init.body — don't
      // consume. (We can only safely consume a Request body via clone, below.)
      return 0;
    }
    // No init body — if input is a Request with a body, clone it and read the
    // cloned body. The clone tees the underlying body stream, so the original
    // Request remains intact for fetch to consume on the wire.
    if (
      typeof input === "object" &&
      input !== null &&
      !(input instanceof URL) &&
      typeof (input as Request).clone === "function" &&
      (input as Request).body != null
    ) {
      try {
        const cloned = (input as Request).clone();
        const buf = await cloned.arrayBuffer();
        return buf.byteLength;
      } catch {
        return 0;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// RawEvent builder
// ---------------------------------------------------------------------------

function buildEvent(
  parsed: ParsedUrl,
  method: string,
  statusCode: number,
  latencyMs: number,
  requestBytes: number,
  responseBytes: number,
): RawEvent {
  return {
    timestamp: isoNow(),
    method: method.toUpperCase(),
    url: parsed.url,
    host: parsed.host,
    path: parsed.path,
    statusCode,
    latencyMs: Math.round(latencyMs),
    requestBytes,
    responseBytes,
    provider: null,
    endpointCategory: null,
    error: statusCode === 0 || statusCode >= 400,
  };
}

// ---------------------------------------------------------------------------
// Fetch wrapper
// ---------------------------------------------------------------------------

const patchedFetch: typeof globalThis.fetch = async (input, init?) => {
  let parsed: ParsedUrl | null = null;
  let method = "GET";
  let requestBytes = 0;
  let requestBytesPromise: Promise<number> | null = null;

  try {
    parsed = extractUrl(input);
    if (typeof input === "object" && input !== null && "method" in input) {
      method = (input as Request).method ?? "GET";
    }
    if (init?.method) method = init.method;
  } catch {
    // Metadata extraction failed — proceed without instrumentation
  }

  if (parsed === null) {
    return _originalFetch!(input, init);
  }

  // Kick off async request-body measurement only once we know we'll record
  // an event for this fetch. Doing this before the parsed === null guard
  // would orphan a clone+arrayBuffer for requests we ultimately skip.
  requestBytesPromise = estimateRequestBytes(input, init);

  const startTime = performance.now();
  _inFetchWrapper = true;

  try {
    const response = await _originalFetch!(input, init);

    // Resolve async request-body measurement. The clone tee inside
    // estimateRequestBytes runs in parallel with the real wire request, so
    // for small bodies it's typically already settled by the time fetch
    // resolves the response. Worst-case (large streaming uploads), awaiting
    // here delays the telemetry emit until the cloned body is fully
    // materialized into an ArrayBuffer — peak memory roughly doubles for
    // the body and telemetry latency rises with body size. Acceptable for a
    // telemetry library; the alternative is reporting requestBytes: 0 for
    // the common modern fetch(new Request(url, { body })) pattern.
    // estimateRequestBytes never throws (all paths return 0 on error).
    if (requestBytesPromise !== null) {
      requestBytes = await requestBytesPromise;
    }

    // Capture immutable values up-front; the body completion handler
    // may run long after this scope returns.
    const capturedParsed = parsed;
    const capturedMethod = method;
    const capturedRequestBytes = requestBytes;
    const status = response.status;
    const contentLengthHeader = response.headers.get("content-length");
    const headerBytes = contentLengthHeader != null ? (parseInt(contentLengthHeader, 10) || 0) : 0;

    // Bodyless response (HEAD, 204, 304, or non-streaming nullable body):
    // record latency now (it is by definition both headers- and body-time)
    // and fall back to the content-length header for responseBytes.
    if (response.body == null) {
      try {
        const latencyMs = performance.now() - startTime;
        _callback?.(buildEvent(capturedParsed, capturedMethod, status, latencyMs, capturedRequestBytes, headerBytes));
      } catch {
        // Telemetry error — swallow
      }
      return response;
    }

    // Streaming / non-empty body: tee the body so we can count bytes
    // independently of the caller. The caller-facing branch is returned
    // in a cloned Response; the counting branch is drained internally
    // and resolves telemetry at end-of-body. This guarantees telemetry
    // fires whether the caller reads, cancels, or abandons the body.
    let observedBytes = 0;
    let telemetryFired = false;
    const fireTelemetry = (statusForEvent: number): void => {
      if (telemetryFired) return;
      telemetryFired = true;
      try {
        const latencyMs = performance.now() - startTime;
        const responseBytes = observedBytes > 0 ? observedBytes : headerBytes;
        _callback?.(buildEvent(capturedParsed, capturedMethod, statusForEvent, latencyMs, capturedRequestBytes, responseBytes));
      } catch {
        // Telemetry error — swallow
      }
    };

    const [forCaller, forCounter] = response.body.tee();

    void (async (): Promise<void> => {
      const reader = forCounter.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value != null) observedBytes += value.byteLength;
        }
      } catch {
        // Source errored — still fire telemetry with whatever we observed.
      } finally {
        fireTelemetry(status);
      }
    })();

    return new Response(forCaller, response);
  } catch (fetchError) {
    // Resolve async request-body measurement before recording the error event,
    // so a failed-with-body request still reports requestBytes accurately.
    if (requestBytesPromise !== null) {
      try {
        requestBytes = await requestBytesPromise;
      } catch {
        // estimateRequestBytes never throws; defensive only
      }
    }

    try {
      const latencyMs = performance.now() - startTime;
      _callback?.(buildEvent(parsed, method, 0, latencyMs, requestBytes, 0));
    } catch {
      // Telemetry error — swallow
    }

    throw fetchError;
  } finally {
    // Always reset the re-entrancy guard — a throw anywhere between
    // the `true` assignment and here would otherwise leak it permanently
    // and silently drop every future http.request event.
    _inFetchWrapper = false;
  }
};

// ---------------------------------------------------------------------------
// http.request / https.request wrapper factory
// ---------------------------------------------------------------------------

type HttpRequestFn = typeof http.request;
type HttpGetFn = typeof http.get;

function makeRequestWrapper(originalRequest: HttpRequestFn): HttpRequestFn {
  const wrapper = function (
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    maybeCallback?: (res: http.IncomingMessage) => void,
  ): http.ClientRequest {
    // Prevent double-counting when fetch delegates internally to http.request
    if (_inFetchWrapper) {
      // @ts-expect-error forwarding original overloaded signature
      return originalRequest(urlOrOptions, optionsOrCallback, maybeCallback);
    }

    let parsed: ParsedUrl | null = null;
    let method = "GET";
    let requestBytes = 0;

    try {
      // When the first arg is a URL or URL-like string, an options.path on the
      // second arg overrides the URL's pathname (matching Node's actual request
      // routing). When the first arg is RequestOptions itself, the path inside
      // it is already consumed by extractUrl's RequestOptions branch — no
      // override needed (and applying one would be a no-op anyway).
      const firstArgIsUrlish =
        typeof urlOrOptions === "string" || urlOrOptions instanceof URL;
      const secondArgPath: string | undefined =
        typeof optionsOrCallback === "object" &&
        optionsOrCallback !== null &&
        typeof (optionsOrCallback as http.RequestOptions).path === "string"
          ? ((optionsOrCallback as http.RequestOptions).path as string)
          : undefined;
      const pathOverride = firstArgIsUrlish ? secondArgPath : undefined;

      parsed = extractUrl(urlOrOptions, pathOverride);

      if (typeof urlOrOptions === "object" && !(urlOrOptions instanceof URL) && urlOrOptions.method) {
        method = urlOrOptions.method;
      }
      if (
        typeof optionsOrCallback === "object" &&
        optionsOrCallback !== null &&
        (optionsOrCallback as http.RequestOptions).method
      ) {
        method = (optionsOrCallback as http.RequestOptions).method!;
      }

      const opts = typeof urlOrOptions === "object" && !(urlOrOptions instanceof URL)
        ? urlOrOptions as http.RequestOptions
        : typeof optionsOrCallback === "object" && optionsOrCallback !== null
          ? optionsOrCallback as http.RequestOptions
          : null;

      if (opts?.headers && typeof opts.headers === "object") {
        const cl = (opts.headers as Record<string, string | string[]>)["content-length"];
        if (cl != null) {
          requestBytes = parseInt(Array.isArray(cl) ? cl[0]! : cl, 10) || 0;
        }
      }
    } catch {
      // Metadata extraction failed — proceed without instrumentation
    }

    const startTime = performance.now();

    // @ts-expect-error forwarding original overloaded signature
    const req: http.ClientRequest = originalRequest(urlOrOptions, optionsOrCallback, maybeCallback);

    if (parsed === null) return req;

    const capturedParsed = parsed;
    const capturedMethod = method;
    const capturedRequestBytes = requestBytes;

    try {
      req.once("response", (res: http.IncomingMessage) => {
        try {
          const statusCode = res.statusCode ?? 0;
          const contentLength = res.headers["content-length"];
          const headerBytes = contentLength != null ? (parseInt(contentLength, 10) || 0) : 0;

          // Accumulate observed bytes for chunked / no-content-length
          // responses. We do not consume data: IncomingMessage is a
          // multi-listener EventEmitter, so this listener runs alongside
          // the caller's listener with no effect on what the caller sees.
          let observedBytes = 0;
          res.on("data", (chunk: Buffer | string) => {
            try {
              observedBytes += typeof chunk === "string"
                ? Buffer.byteLength(chunk)
                : chunk.length;
            } catch {
              // Swallow
            }
          });

          res.once("close", () => {
            try {
              const latencyMs = performance.now() - startTime;
              const responseBytes = observedBytes > 0 ? observedBytes : headerBytes;
              _callback?.(buildEvent(capturedParsed, capturedMethod, statusCode, latencyMs, capturedRequestBytes, responseBytes));
            } catch {
              // Swallow
            }
          });
        } catch {
          // Swallow
        }
      });

      req.once("error", () => {
        try {
          const latencyMs = performance.now() - startTime;
          _callback?.(buildEvent(capturedParsed, capturedMethod, 0, latencyMs, capturedRequestBytes, 0));
        } catch {
          // Swallow
        }
      });
    } catch {
      // Event listener attachment failed — return request untouched
    }

    return req;
  };

  return wrapper as unknown as HttpRequestFn;
}

function makeGetWrapper(patchedRequest: HttpRequestFn): HttpGetFn {
  const wrapper = function (
    urlOrOptions: string | URL | http.RequestOptions,
    optionsOrCallback?: http.RequestOptions | ((res: http.IncomingMessage) => void),
    maybeCallback?: (res: http.IncomingMessage) => void,
  ): http.ClientRequest {
    // @ts-expect-error forwarding overloaded signature
    const req = patchedRequest(urlOrOptions, optionsOrCallback, maybeCallback);
    req.end();
    return req;
  };

  return wrapper as unknown as HttpGetFn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Installs patches on globalThis.fetch, http.request, https.request,
 * http.get, and https.get. No-op if already installed.
 */
export function install(callback: EventCallback): void {
  if (_installed) return;

  _callback = callback;

  _originalFetch = globalThis.fetch;
  _originalHttpRequest = http.request;
  _originalHttpGet = http.get;
  _originalHttpsRequest = https.request;
  _originalHttpsGet = https.get;

  globalThis.fetch = patchedFetch;

  const patchedHttpRequest = makeRequestWrapper(_originalHttpRequest);
  const patchedHttpsRequest = makeRequestWrapper(_originalHttpsRequest);

  (http as unknown as { request: HttpRequestFn }).request = patchedHttpRequest;
  (http as unknown as { get: HttpGetFn }).get = makeGetWrapper(patchedHttpRequest);
  (https as unknown as { request: HttpRequestFn }).request = patchedHttpsRequest;
  (https as unknown as { get: HttpGetFn }).get = makeGetWrapper(patchedHttpsRequest);

  _installed = true;
}

/**
 * Restores all patched functions to their originals. No-op if not installed.
 */
export function uninstall(): void {
  if (!_installed) return;

  if (_originalFetch != null) globalThis.fetch = _originalFetch;
  if (_originalHttpRequest != null) (http as unknown as { request: HttpRequestFn }).request = _originalHttpRequest;
  if (_originalHttpGet != null) (http as unknown as { get: HttpGetFn }).get = _originalHttpGet;
  if (_originalHttpsRequest != null) (https as unknown as { request: HttpRequestFn }).request = _originalHttpsRequest;
  if (_originalHttpsGet != null) (https as unknown as { get: HttpGetFn }).get = _originalHttpsGet;

  _callback = null;
  _originalFetch = null;
  _originalHttpRequest = null;
  _originalHttpGet = null;
  _originalHttpsRequest = null;
  _originalHttpsGet = null;
  _inFetchWrapper = false;
  _installed = false;
}

/** Returns true if patches are currently active. */
export function isInstalled(): boolean {
  return _installed;
}


/**
 * Returns the original, unpatched fetch for internal SDK use (e.g. transport).
 * Falls back to globalThis.fetch if called before install().
 */
export function getRawFetch(): typeof globalThis.fetch {
  return _originalFetch ?? globalThis.fetch;
}
