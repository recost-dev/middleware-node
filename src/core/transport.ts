/**
 * Transport — delivers WindowSummary payloads to either:
 *   - api.recost.dev (cloud mode) via HTTPS POST with exponential-backoff retry, or
 *   - the ReCost VS Code extension (local mode) via WebSocket on localhost.
 *
 * Uses getRawFetch() from the interceptor so SDK HTTP calls are never self-instrumented.
 */

import WebSocket from "ws";
import type { RecostConfig, TransportMode, WindowSummary } from "./types.js";
import { getRawFetch } from "./interceptor.js";

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
): Promise<void> {
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

      if (res.ok) return;

      // 4xx errors are not retriable — drop the payload
      if (res.status >= 400 && res.status < 500) return;

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

  // Local WebSocket state
  private _ws: WebSocket | null = null;
  private _wsQueue: string[] = [];
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;

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
      // Drain queued messages
      for (const msg of this._wsQueue) {
        try { ws.send(msg); } catch { /* swallow */ }
      }
      this._wsQueue = [];
    });

    ws.on("close", () => {
      this._ws = null;
      this._scheduleReconnect();
    });

    ws.on("error", () => {
      // "error" always precedes "close" — handled there
    });
  }

  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer !== null) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWs();
    }, 3_000);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Send a WindowSummary. Never throws — errors are forwarded to onError. */
  async send(summary: WindowSummary): Promise<void> {
    const body = JSON.stringify(summary);

    try {
      if (this._cfg.mode === "cloud") {
        const url = `${this._cfg.baseUrl}/projects/${this._cfg.projectId}/telemetry`;
        await postCloud(url, body, this._cfg.apiKey, this._cfg.maxRetries);
      } else {
        // Local WebSocket
        if (this._ws?.readyState === WebSocket.OPEN) {
          this._ws.send(body);
        } else {
          // Queue for when the connection opens
          this._wsQueue.push(body);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this._cfg.onError) {
        this._cfg.onError(error);
      } else if (this._cfg.debug) {
        console.error("[recost] transport error:", error.message);
      }
    }
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
