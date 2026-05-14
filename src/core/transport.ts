/**
 * Transport — delivers WindowSummary payloads to either:
 *   - api.recost.dev (cloud mode) via HTTPS POST with exponential-backoff retry, or
 *   - the ReCost VS Code extension (local mode) via WebSocket on localhost.
 *
 * Uses getRawFetch() from the interceptor so SDK HTTP calls are never self-instrumented.
 */

import WebSocket from "ws";
import type { FlushStatus, RecostConfig, TransportMode, WindowSummary } from "./types.js";
import { RecostAuthError, RecostFatalAuthError, RecostLocalUnreachableError } from "./types.js";
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
  maxConsecutiveAuthFailures: number;
  maxConsecutiveReconnectFailures: number;
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
    maxConsecutiveAuthFailures: config.maxConsecutiveAuthFailures ?? 5,
    maxConsecutiveReconnectFailures: config.maxConsecutiveReconnectFailures ?? 20,
    debug: config.debug ?? false,
    onError: config.onError,
  };
}

// ---------------------------------------------------------------------------
// Cloud transport helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postCloud(
  url: string,
  body: string,
  apiKey: string,
  maxRetries: number,
): Promise<{ ok: boolean; status: number }> {
  const rawFetch = getRawFetch();
  let lastError: unknown;

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

      // 4xx errors are not retriable — drop the payload, but return status for logging
      if (res.status >= 400 && res.status < 500) return { ok: false, status: res.status };

      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxRetries) {
      await sleep(Math.min(1000 * 2 ** attempt, 10_000));
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
   * True once `_reconnectAttempts` has reached `_cfg.maxConsecutiveReconnectFailures`.
   * Never flipped back — recovery is process-restart-only in this PR. Causes
   * `_scheduleReconnect` to no-op and `_sendOne`'s local branch to short-circuit
   * to a silent no-op.
   */
  private _localPaused = false;

  /**
   * Count of consecutive 401 responses from the cloud API. Increments on every
   * 401, resets to 0 on any non-401 outcome (success, non-401 4xx, 5xx-after-
   * retries, network throw). When it reaches `_cfg.maxConsecutiveAuthFailures`,
   * `_cloudSuspended` is flipped true for the lifetime of this Transport.
   */
  private _consecutiveAuthFailures = 0;

  /**
   * True once `_consecutiveAuthFailures` has reached the threshold. Never
   * flipped back — recovery is process-restart-only in this PR. Causes
   * `_sendOne`'s cloud branch to short-circuit to a silent no-op.
   */
  private _cloudSuspended = false;

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
    if (this._disposed || this._localPaused) return;

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
   */
  private _computeBackoffMs(): number {
    const base = Math.min(500 * 2 ** this._reconnectAttempts, 30_000);
    const jitter = 1 + (Math.random() - 0.5) * 0.5; // 0.75..1.25
    return Math.floor(base * jitter);
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer !== null) return;

    if (this._reconnectAttempts >= this._cfg.maxConsecutiveReconnectFailures) {
      this._handleLocalUnreachable();
      return;
    }

    const delay = this._computeBackoffMs();
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWs();
    }, delay);
  }

  /**
   * Pause the local transport after the consecutive-failure threshold is
   * reached. Idempotent — the `_localPaused` latch and the early-return in
   * `_scheduleReconnect` prevent re-entry. Emits one stderr line, one
   * `onError(RecostLocalUnreachableError)`, and drops the queued payloads
   * we will never deliver.
   */
  private _handleLocalUnreachable(): void {
    if (this._localPaused) return;          // defensive — should not be reachable
    this._localPaused = true;
    const n = this._reconnectAttempts;

    process.stderr.write(
      `[recost] local WebSocket unreachable after ${n} consecutive reconnect attempts. ` +
      `Restart the process after starting the VS Code extension.\n`,
    );

    if (this._cfg.onError) {
      this._cfg.onError(new RecostLocalUnreachableError(n));
    }

    // We will never drain — release the bounded memory.
    this._wsQueue = [];
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
        // Suspended after N consecutive 401s — silent no-op until restart.
        if (this._cloudSuspended) {
          this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
          return;
        }

        const url = `${this._cfg.baseUrl}/projects/${this._cfg.projectId}/telemetry`;
        const result = await postCloud(url, body, this._cfg.apiKey, this._cfg.maxRetries);

        if (result.ok) {
          this._consecutiveAuthFailures = 0;
          this._lastFlushStatus = { status: "ok", windowSize, timestamp: Date.now() };
          return;
        }

        if (result.status === 401) {
          this._handleAuthFailure(windowSize);
          return;
        }

        // Non-401 rejection (403/404/422/etc.) — counter resets, existing
        // behavior preserved.
        this._consecutiveAuthFailures = 0;
        this._reportRejection(result.status, windowSize);
        this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
        return;
      }

      // Local WebSocket
      if (this._localPaused) {
        this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
        return;
      }

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
      // Network throw / retries-exhausted: counter resets — we did not get
      // a 401 response, so we cannot prove the key is bad.
      this._consecutiveAuthFailures = 0;
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
    // 401 is handled in _handleAuthFailure before this method is reached.
    const reason = status === 403
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

  /**
   * Handle a 401 response. Increments the consecutive-failure counter, emits
   * the appropriate stderr line(s), fires `RecostAuthError` (or
   * `RecostFatalAuthError` once the threshold is reached), and — when fatal —
   * flips `_cloudSuspended` so subsequent sends short-circuit to a no-op.
   *
   * The first 401 of an episode emits a one-time stderr warning so hosts that
   * never wired `onError` still see something. The fatal threshold emits a
   * second, distinct stderr line announcing the suspension. 401s between #1
   * and the threshold are stderr-silent — `onError` carries the per-event
   * detail for hosts that wired it.
   */
  private _handleAuthFailure(windowSize: number): void {
    this._consecutiveAuthFailures += 1;
    const n = this._consecutiveAuthFailures;
    const threshold = this._cfg.maxConsecutiveAuthFailures;
    const isFirst = n === 1;
    const isFatal = n >= threshold;

    if (isFirst) {
      process.stderr.write(
        `[recost] HTTP 401 — API key rejected. Telemetry will stop after ` +
        `${threshold} consecutive failures. Check your apiKey at ` +
        `https://recost.dev/dashboard/account.\n`,
      );
    }

    if (isFatal) {
      this._cloudSuspended = true;
      process.stderr.write(
        `[recost] cloud transport suspended after ${n} consecutive auth failures. ` +
        `Restart the process after rotating apiKey.\n`,
      );
      if (this._cfg.onError) {
        this._cfg.onError(new RecostFatalAuthError(401, n));
      }
    } else if (this._cfg.onError) {
      this._cfg.onError(new RecostAuthError(401, n));
    }

    this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
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
