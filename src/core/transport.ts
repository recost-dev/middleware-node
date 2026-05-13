/**
 * Transport — delivers WindowSummary payloads to either:
 *   - api.recost.dev (cloud mode) via HTTPS POST with exponential-backoff retry, or
 *   - the ReCost VS Code extension (local mode) via WebSocket on localhost.
 *
 * Uses getRawFetch() from the interceptor so SDK HTTP calls are never self-instrumented.
 */

import WebSocket from "ws";
import type { FlushStatus, RecostConfig, TransportMode, WindowSummary } from "./types.js";
import { getRawFetch } from "./interceptor.js";
import { MAX_BUCKETS } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Resolved config (apply all defaults once at construction)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  mode: TransportMode;
  apiKey: string;
  projectId: string;
  baseUrl: string;
  localPort: number;
  maxRetries: number;
  maxBuckets: number;
  maxWsQueueSize: number;
  debug: boolean;
  onError?: ((err: Error) => void) | undefined;
}

function resolveConfig(config: RecostConfig): ResolvedConfig {
  return {
    mode: config.apiKey ? "cloud" : "local",
    apiKey: config.apiKey ?? "",
    projectId: config.projectId ?? "",
    baseUrl: (config.baseUrl ?? "https://api.recost.dev").replace(/\/$/, ""),
    localPort: config.localPort ?? 9847,
    maxRetries: config.maxRetries ?? 3,
    maxBuckets: config.maxBuckets ?? MAX_BUCKETS,
    maxWsQueueSize: config.maxWsQueueSize ?? 1000,
    debug: config.debug ?? false,
    onError: config.onError,
  };
}

// ---------------------------------------------------------------------------
// Cloud transport helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Status codes that indicate a transient failure worth retrying. Other 4xx
 * (e.g. 400, 401, 403, 404, 422) are caller errors and must NOT be retried. */
const RETRYABLE_STATUS = new Set<number>([429, 503]);

/**
 * Parse an HTTP `Retry-After` header (RFC 7231 §7.1.3). Accepts:
 *   - integer seconds, e.g. `"2"` -> 2000ms
 *   - HTTP-date, e.g. `"Wed, 13 May 2026 12:00:03 GMT"` -> delta from now
 * Past dates and unparsable input return `null` (caller falls back to backoff).
 * Negative deltas (clock skew, retry target in the past) clamp to 0.
 */
function parseRetryAfter(header: string | null | undefined): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const delta = ts - Date.now();
  return delta > 0 ? delta : 0;
}

/** Apply ±25% jitter to a base delay so clock-aligned SDK fleets do not retry
 * in lockstep after an outage. Shared between the cloud retry path and the WS
 * reconnect path so both languages of the SDK behave identically. */
function applyJitter(baseMs: number): number {
  const jitter = 1 + (Math.random() - 0.5) * 0.5;
  return Math.floor(baseMs * jitter);
}

async function postCloud(
  url: string,
  body: string,
  apiKey: string,
  maxRetries: number,
): Promise<{ ok: boolean; status: number }> {
  const rawFetch = getRawFetch();
  let lastError: unknown;
  /** Set by the previous iteration if the response carried a Retry-After
   * header we want to honor on the next sleep. Cleared after consumption. */
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await rawFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`,
        },
        body,
      });

      if (res.ok) return { ok: true, status: res.status };

      // Retryable transient status: 429 (rate limit) or 503 (unavailable).
      // Honor Retry-After if present, else fall through to backoff below.
      if (RETRYABLE_STATUS.has(res.status)) {
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        lastError = new Error(`HTTP ${res.status}`);
      } else if (res.status >= 400 && res.status < 500) {
        // Non-retryable caller error — drop the payload, return status for logging.
        return { ok: false, status: res.status };
      } else {
        // 5xx other than 503 — generic retryable server error, no header to honor.
        retryAfterMs = null;
        lastError = new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      // Network-level failure — retryable, no header to honor.
      retryAfterMs = null;
      lastError = err;
    }

    if (attempt < maxRetries) {
      const baseMs = retryAfterMs != null
        ? retryAfterMs
        : Math.min(1000 * 2 ** attempt, 10_000);
      await sleep(applyJitter(baseMs));
      retryAfterMs = null;
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Transport class
// ---------------------------------------------------------------------------

/** Delivers WindowSummary objects to the cloud API or the local VS Code extension. */
export class Transport {
  readonly mode: TransportMode;
  private readonly _cfg: ResolvedConfig;
  private _lastFlushStatus: FlushStatus | null = null;

  // Local WebSocket state
  private _ws: WebSocket | null = null;
  private _wsQueue: string[] = [];
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _disposed = false;
  /**
   * True once we have already fired an onError notification for the current
   * overflow episode. Reset to false the moment the queue drains back to
   * empty (in the `ws.on("open", ...)` drain handler). Guarantees at most
   * one notification per outage.
   */
  private _dropNotified = false;

  /**
   * Test-only accessor for the current queued-payload count. Intentionally
   * underscore-prefixed and not exported from `src/index.ts` — there is no
   * production reason to read the queue depth from outside this module.
   */
  _queueSize(): number {
    return this._wsQueue.length;
  }

  constructor(config: RecostConfig) {
    this._cfg = resolveConfig(config);
    this.mode = this._cfg.mode;

    if (this._cfg.mode === "local") {
      this._connectWs();
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket management (local mode)
  // ---------------------------------------------------------------------------

  private _connectWs(): void {
    if (this._disposed) return;

    const url = `ws://127.0.0.1:${this._cfg.localPort}`;
    let ws: WebSocket;

    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      this._ws = ws;
      // Successful connect resets the backoff so the next disconnect retries
      // promptly instead of inheriting whatever delay the previous outage hit.
      this._reconnectAttempts = 0;
      // Drain queued messages
      for (const msg of this._wsQueue) {
        try { ws.send(msg); } catch { /* swallow */ }
      }
      this._wsQueue = [];
      // The queue is empty again — this overflow episode is over. Future
      // outages get a fresh notification.
      this._dropNotified = false;
    });

    ws.on("close", () => {
      this._ws = null;
      this._scheduleReconnect();
    });

    ws.on("error", () => {
      // "error" always precedes "close" — handled there
    });
  }

  /**
   * Exponential backoff with ±25% jitter:
   *   500ms, 1s, 2s, 4s, 8s, 16s, 30s (capped) — each ±25% random.
   *
   * Aligned with the Python SDK's _LocalTransport so both languages behave
   * identically on flaky local-extension restarts. Linear 3s retry was chosen
   * for simplicity but tends to thrash when the extension is genuinely down.
   *
   * Jitter math lives in the shared `applyJitter` helper so the cloud retry
   * path and this WS reconnect path stay in lockstep.
   */
  private _computeBackoffMs(): number {
    const base = Math.min(500 * 2 ** this._reconnectAttempts, 30_000);
    return applyJitter(base);
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer !== null) return;
    const delay = this._computeBackoffMs();
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWs();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Outcome of the most recent flush, or null if no flush has completed. */
  get lastFlushStatus(): FlushStatus | null {
    return this._lastFlushStatus;
  }

  /**
   * Send a WindowSummary. Never throws — errors are forwarded to onError.
   *
   * If the summary has more than maxBuckets metrics (degenerate burst case),
   * it is split into chunks of up to maxBuckets and sent sequentially. The
   * lastFlushStatus property reflects the final chunk's outcome.
   */
  async send(summary: WindowSummary): Promise<void> {
    if (summary.metrics.length > this._cfg.maxBuckets) {
      const chunkSize = this._cfg.maxBuckets;
      for (let i = 0; i < summary.metrics.length; i += chunkSize) {
        const chunk: WindowSummary = {
          ...summary,
          metrics: summary.metrics.slice(i, i + chunkSize),
        };
        await this._sendOne(chunk);
      }
      return;
    }
    await this._sendOne(summary);
  }

  private async _sendOne(summary: WindowSummary): Promise<void> {
    const body = JSON.stringify(summary);
    const windowSize = summary.metrics.length;

    try {
      if (this._cfg.mode === "cloud") {
        const url = `${this._cfg.baseUrl}/projects/${this._cfg.projectId}/telemetry`;
        const result = await postCloud(url, body, this._cfg.apiKey, this._cfg.maxRetries);
        if (!result.ok) {
          this._reportRejection(result.status, windowSize);
          this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
          return;
        }
        this._lastFlushStatus = { status: "ok", windowSize, timestamp: Date.now() };
        return;
      }

      // Local WebSocket
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(body);
      } else {
        // Queue for when the connection opens. If the queue is already at
        // capacity, drop the oldest payload (FIFO) and — on the first drop
        // of this overflow episode — fire one onError so the host knows
        // telemetry is being shed. _dropNotified is reset when the queue
        // next drains to empty (see ws.on("open", ...)) so a future outage
        // gets a fresh notification.
        if (this._wsQueue.length >= this._cfg.maxWsQueueSize) {
          this._wsQueue.shift();
          if (!this._dropNotified) {
            this._dropNotified = true;
            const overflowErr = new Error(
              "recost: WebSocket queue overflowed; oldest messages dropped",
            );
            if (this._cfg.onError) this._cfg.onError(overflowErr);
          }
        }
        this._wsQueue.push(body);
      }
      this._lastFlushStatus = { status: "ok", windowSize, timestamp: Date.now() };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const msg = `[recost] transport error (windowSize=${windowSize}): ${error.message}`;
      console.warn(msg);
      if (this._cfg.onError) {
        this._cfg.onError(error);
      }
      this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
    }
  }

  /**
   * Emit a warning for a non-2xx ingest response. Warning is always logged
   * (regardless of debug) and onError is fired if configured. Data loss on
   * rejection was silent before — this restores observability.
   */
  private _reportRejection(status: number, windowSize: number): void {
    const reason = status === 401
      ? "API key is invalid or has been revoked. Check RECOST_API_KEY."
      : status === 403
        ? "API key does not have access to this project. Check RECOST_PROJECT_ID."
        : status === 404
          ? "Project not found. Check RECOST_PROJECT_ID."
          : status === 422
            ? "telemetry payload rejected (possibly over the 2000-bucket limit)"
            : "telemetry payload rejected";
    const msg = `[recost] HTTP ${status} — ${reason} (windowSize=${windowSize})`;
    console.warn(msg);
    if (this._cfg.onError) this._cfg.onError(new Error(msg));
  }

  /** Close WebSocket and cancel pending reconnect. */
  dispose(): void {
    this._disposed = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._ws?.close();
    this._ws = null;
  }
}
