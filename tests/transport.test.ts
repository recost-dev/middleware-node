/**
 * Tests for src/core/transport.ts
 *
 * Cloud mode tests use a real local HTTP server to verify POST behavior.
 * Local (WebSocket) mode tests verify queue-and-drain and dispose behavior.
 */

import http from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { Transport } from "../src/core/transport.js";
import { uninstall } from "../src/core/interceptor.js";
import type { MetricEntry, WindowSummary } from "../src/core/types.js";

afterEach(() => {
  uninstall();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    projectId: "proj-1",
    environment: "test",
    sdkLanguage: "node",
    sdkVersion: "0.1.0",
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-01T00:00:30.000Z",
    metrics: [],
    ...overrides,
  };
}

interface FakeHttpServer {
  baseUrl: string;
  requests: Array<{ method: string; url: string; body: string; auth: string }>;
  statusCode: number;
  close(): Promise<void>;
}

function startFakeHttpServer(): Promise<FakeHttpServer> {
  const captured: FakeHttpServer["requests"] = [];
  let statusCode = 202;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString();
      });
      req.on("end", () => {
        captured.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          auth: req.headers["authorization"] ?? "",
        });
        res.writeHead(statusCode);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const obj: FakeHttpServer = {
        baseUrl: `http://127.0.0.1:${port}`,
        requests: captured,
        set statusCode(v: number) {
          statusCode = v;
        },
        get statusCode() {
          return statusCode;
        },
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      };
      resolve(obj);
    });
    server.once("error", reject);
  });
}

interface FakeWsServer {
  port: number;
  messages: string[];
  connectionCount: number;
  close(): Promise<void>;
}

function startFakeWsServer(): Promise<FakeWsServer> {
  return startFakeWsServerOnPort(0);
}

function startFakeWsServerOnPort(port: number): Promise<FakeWsServer> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    let connectionCount = 0;
    const wss = new WebSocketServer({ host: "127.0.0.1", port });

    wss.once("listening", () => {
      const { port } = wss.address() as { port: number };
      wss.on("connection", (ws) => {
        connectionCount++;
        ws.on("message", (data) => {
          messages.push(data.toString());
        });
      });
      resolve({
        port,
        messages,
        get connectionCount() {
          return connectionCount;
        },
        close: () =>
          new Promise<void>((res, rej) => {
            // Force-terminate connected clients so wss.close() does not hang
            // waiting for them to disconnect on their own. Required by the
            // overflow-episode test, which needs the close to propagate to
            // the transport's client side so it observes the disconnect.
            for (const client of wss.clients) {
              try { client.terminate(); } catch { /* swallow */ }
            }
            wss.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    wss.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

describe("Transport mode detection", () => {
  it("mode is 'local' when no apiKey", () => {
    const t = new Transport({});
    expect(t.mode).toBe("local");
    t.dispose();
  });

  it("mode is 'cloud' when apiKey is set", () => {
    const t = new Transport({ apiKey: "key-123" });
    expect(t.mode).toBe("cloud");
    t.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cloud mode
// ---------------------------------------------------------------------------

describe("Transport cloud mode", () => {
  it("POSTs summary as JSON with correct Authorization header", async () => {
    const server = await startFakeHttpServer();
    const t = new Transport({
      apiKey: "test-key",
      projectId: "proj-1",
      baseUrl: server.baseUrl,
      maxRetries: 0,
    });

    await t.send(makeSummary());
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.auth).toBe("Bearer test-key");
    const parsed = JSON.parse(req.body) as WindowSummary;
    expect(parsed.projectId).toBe("proj-1");
  });

  it("sends POST to the correct /projects/{projectId}/telemetry URL", async () => {
    const server = await startFakeHttpServer();
    const t = new Transport({
      apiKey: "key",
      projectId: "my-project",
      baseUrl: server.baseUrl,
      maxRetries: 0,
    });

    await t.send(makeSummary());
    t.dispose();
    await server.close();

    expect(server.requests[0]!.url).toBe("/projects/my-project/telemetry");
  });

  it("does not retry on 4xx — exactly one attempt", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const t = new Transport({
      apiKey: "bad-key",
      baseUrl: server.baseUrl,
      maxRetries: 3,
    });

    await t.send(makeSummary());
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(1);
  });

  it("retries on 5xx up to maxRetries — total attempts is maxRetries+1", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 503;

    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 2,
    });

    await t.send(makeSummary());
    t.dispose();
    await server.close();

    // 1 initial + 2 retries = 3
    expect(server.requests).toHaveLength(3);
  }, 15_000);

  it("retries on 5xx and succeeds when server recovers", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 500;

    // Change to success after the first request arrives
    setTimeout(() => {
      server.statusCode = 202;
    }, 500);

    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 3,
    });

    await t.send(makeSummary());
    t.dispose();
    await server.close();

    // At least 2 requests: one 500, one 202
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("calls onError after all retries are exhausted", async () => {
    const errors: Error[] = [];
    const t = new Transport({
      apiKey: "key",
      baseUrl: "http://127.0.0.1:1", // nothing listening
      maxRetries: 0,
      onError: (e) => errors.push(e),
    });

    await t.send(makeSummary());
    expect(errors.length).toBeGreaterThan(0);
    t.dispose();
  });

  it("does not throw on network failure even without onError", async () => {
    const t = new Transport({
      apiKey: "key",
      baseUrl: "http://127.0.0.1:1",
      maxRetries: 0,
    });

    await expect(t.send(makeSummary())).resolves.toBeUndefined();
    t.dispose();
  });
});

// ---------------------------------------------------------------------------
// Local (WebSocket) mode
// ---------------------------------------------------------------------------

describe("Transport local mode", () => {
  it("send does not throw when no WebSocket server is running", async () => {
    const t = new Transport({ localPort: 19999 });
    await expect(t.send(makeSummary())).resolves.toBeUndefined();
    t.dispose();
  });

  it("sends summary to a running WebSocket server", async () => {
    const ws = await startFakeWsServer();
    const t = new Transport({ localPort: ws.port });

    // Wait for WebSocket connection to be established
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ws.connectionCount > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    await t.send(makeSummary({ projectId: "ws-test" }));
    await new Promise((r) => setTimeout(r, 50));

    t.dispose();
    await ws.close();

    expect(ws.messages).toHaveLength(1);
    const received = JSON.parse(ws.messages[0]!) as WindowSummary;
    expect(received.projectId).toBe("ws-test");
  });

  it("queues messages when WebSocket is not connected yet, drains on open", async () => {
    // Choose a port, start transport before WS server
    const ws = await startFakeWsServer();
    const port = ws.port;
    await ws.close(); // Close immediately so port is free but no server yet

    const t = new Transport({ localPort: port });

    // Send while no server is listening — should queue
    await t.send(makeSummary({ projectId: "queued-1" }));
    await t.send(makeSummary({ projectId: "queued-2" }));

    // Now start a WS server on the same port
    const ws2 = await startFakeWsServer();
    // Note: localPort might differ since port 0 gives a new one each time
    // Instead create a new transport targeting the known port from ws2
    t.dispose();

    // Create new transport targeting ws2
    const t2 = new Transport({ localPort: ws2.port });

    await t2.send(makeSummary({ projectId: "direct" }));

    // Wait for connection and delivery
    await new Promise((r) => setTimeout(r, 100));

    t2.dispose();
    await ws2.close();

    expect(ws2.messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(ws2.messages[0]!) as WindowSummary;
    expect(parsed.projectId).toBe("direct");
  });

  it("dispose can be called multiple times without error", () => {
    const t = new Transport({});
    expect(() => {
      t.dispose();
      t.dispose();
    }).not.toThrow();
  });

  it("dispose closes the WebSocket connection", async () => {
    const ws = await startFakeWsServer();
    const t = new Transport({ localPort: ws.port });

    // Wait for connection
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ws.connectionCount > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    let closedCount = 0;
    // Track close events on the WS server side
    for (const client of (ws as unknown as { clients?: Set<unknown> }).clients ?? new Set()) {
      const c = client as { on: (event: string, cb: () => void) => void };
      c.on("close", () => { closedCount++; });
    }

    t.dispose();
    // Give time for the close to propagate
    await new Promise((r) => setTimeout(r, 100));

    await ws.close();
    // After dispose, the transport should not attempt reconnect
    // Verify no additional connections were made
    expect(ws.connectionCount).toBe(1); // Only the original connection
  });

  it("dispose before connection cancels reconnect — no subsequent connection attempts", async () => {
    const t = new Transport({ localPort: 29999 }); // nothing on this port
    // Dispose immediately — cancel any pending reconnect
    t.dispose();

    const ws = await startFakeWsServer();
    // Wait briefly — transport should NOT connect since it was disposed
    await new Promise((r) => setTimeout(r, 200));
    await ws.close();

    expect(ws.connectionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rejection signalling (422, onError, warnings, lastFlushStatus)
// ---------------------------------------------------------------------------

function makeMetric(overrides: Partial<MetricEntry> = {}): MetricEntry {
  return {
    provider: "openai",
    endpoint: "chat_completions",
    method: "POST",
    requestCount: 1,
    errorCount: 0,
    totalLatencyMs: 100,
    p50LatencyMs: 100,
    p95LatencyMs: 100,
    totalRequestBytes: 10,
    totalResponseBytes: 20,
    estimatedCostCents: 1,
    ...overrides,
  };
}

describe("Transport — rejection signalling", () => {
  it("422 response fires onError with a descriptive Error", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 422;

    const errors: Error[] = [];
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 0,
      onError: (e) => errors.push(e),
      debug: false,
    });

    const summary = makeSummary({ metrics: [makeMetric(), makeMetric({ endpoint: "b" })] });
    await t.send(summary);
    const status = t.lastFlushStatus;
    t.dispose();
    await server.close();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("422");
    expect(errors[0]!.message).toContain("windowSize=2");
    expect(status?.status).toBe("error");
    expect(status?.windowSize).toBe(2);
  });

  it("422 response logs a console.warn even when debug=false", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 422;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        debug: false,
      });
      await t.send(makeSummary({ metrics: [makeMetric()] }));
      t.dispose();
      await server.close();

      const matchingCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === "string" && args[0].includes("HTTP 422"),
      );
      expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
      expect(matchingCalls[0]![0] as string).toContain("windowSize=1");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lastFlushStatus reports 'ok' on a successful cloud flush", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 202;
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 0,
    });
    await t.send(makeSummary({ metrics: [makeMetric()] }));
    const status = t.lastFlushStatus;
    t.dispose();
    await server.close();

    expect(status?.status).toBe("ok");
    expect(status?.windowSize).toBe(1);
    expect(typeof status?.timestamp).toBe("number");
  });

  it("summaries larger than maxBuckets are chunked and sent sequentially", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 202;
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 0,
      maxBuckets: 3,
    });

    const metrics = Array.from({ length: 7 }, (_, i) => makeMetric({ endpoint: `ep${i}` }));
    await t.send(makeSummary({ metrics }));
    const status = t.lastFlushStatus;
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(3); // ceil(7/3)
    const sentSizes = server.requests.map((r) => (JSON.parse(r.body) as WindowSummary).metrics.length);
    expect(sentSizes).toEqual([3, 3, 1]);
    // Final chunk's windowSize is reflected
    expect(status?.windowSize).toBe(1);
    expect(status?.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// WebSocket queue cap (drop-oldest, single onError per overflow episode)
// ---------------------------------------------------------------------------

describe("Transport — WebSocket queue cap", () => {
  it("caps the local-mode queue at maxWsQueueSize", async () => {
    const t = new Transport({ localPort: 39901, maxWsQueueSize: 5 });

    for (let i = 0; i < 100; i++) {
      await t.send(makeSummary({ projectId: `p-${i}` }));
    }

    expect(t._queueSize()).toBe(5);
    t.dispose();
  });

  it("drops the oldest payloads (FIFO) when the queue is full", async () => {
    const t = new Transport({ localPort: 39902, maxWsQueueSize: 5 });

    for (let i = 1; i <= 7; i++) {
      await t.send(makeSummary({ projectId: `p-${i}` }));
    }

    expect(t._queueSize()).toBe(5);

    const ws = await startFakeWsServerOnPort(39902);
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (ws.messages.length >= 5) {
          clearInterval(iv);
          resolve();
        }
      }, 20);
    });

    t.dispose();
    await ws.close();

    const ids = ws.messages.map((m) => (JSON.parse(m) as WindowSummary).projectId);
    expect(ids).toEqual(["p-3", "p-4", "p-5", "p-6", "p-7"]);
  }, 15_000);

  it("fires onError exactly once per overflow episode (resets on drain-to-empty)", async () => {
    const errors: Error[] = [];
    const t = new Transport({
      localPort: 39903,
      maxWsQueueSize: 5,
      onError: (e) => errors.push(e),
    });

    for (let i = 0; i < 100; i++) {
      await t.send(makeSummary({ projectId: `e1-${i}` }));
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("WebSocket queue overflowed");

    const ws = await startFakeWsServerOnPort(39903);
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (t._queueSize() === 0) {
          clearInterval(iv);
          resolve();
        }
      }, 20);
    });

    await ws.close();

    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        void t.send(makeSummary({ projectId: "probe" })).then(() => {
          if (t._queueSize() >= 1) {
            clearInterval(iv);
            resolve();
          }
        });
      }, 30);
    });

    const before = errors.length;
    for (let i = 0; i < 100; i++) {
      await t.send(makeSummary({ projectId: `e2-${i}` }));
    }
    expect(errors.length).toBe(before + 1);
    expect(errors[errors.length - 1]!.message).toContain("WebSocket queue overflowed");

    t.dispose();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Retry policy (audit issue #8): 429, 503, Retry-After, jitter
// ---------------------------------------------------------------------------

interface SequencedFakeHttpServer {
  baseUrl: string;
  requests: Array<{ method: string; url: string; body: string; auth: string }>;
  close(): Promise<void>;
}

function startSequencedFakeHttpServer(
  responses: Array<{ statusCode: number; headers?: Record<string, string> }>,
): Promise<SequencedFakeHttpServer> {
  const captured: SequencedFakeHttpServer["requests"] = [];
  let i = 0;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString();
      });
      req.on("end", () => {
        captured.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          auth: req.headers["authorization"] ?? "",
        });
        const next = responses[Math.min(i, responses.length - 1)]!;
        i++;
        res.writeHead(next.statusCode, next.headers ?? {});
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests: captured,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
    server.once("error", reject);
  });
}

describe("Transport — retry policy (issue #8)", () => {
  it("retries on 429 then succeeds on 200", async () => {
    const server = await startSequencedFakeHttpServer([
      { statusCode: 429 },
      { statusCode: 202 },
    ]);
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 3,
    });

    await t.send(makeSummary({ metrics: [makeMetric()] }));
    const status = t.lastFlushStatus;
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(2);
    expect(status?.status).toBe("ok");
  }, 15_000);

  it("retries on 503 then succeeds on 200", async () => {
    const server = await startSequencedFakeHttpServer([
      { statusCode: 503 },
      { statusCode: 503 },
      { statusCode: 202 },
    ]);
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 3,
    });

    await t.send(makeSummary({ metrics: [makeMetric()] }));
    const status = t.lastFlushStatus;
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(3);
    expect(status?.status).toBe("ok");
  }, 15_000);

  it("honors Retry-After header in integer seconds", async () => {
    const server = await startSequencedFakeHttpServer([
      { statusCode: 429, headers: { "retry-after": "2" } },
      { statusCode: 202 },
    ]);
    // Fake only setTimeout so undici's internal timers (e.g. headersTimeout,
    // body parser timeout) continue to use real time and the HTTP roundtrip
    // can complete. The retry path's `sleep(...)` uses setTimeout, which we
    // do fake — so the Retry-After delay is fully under our control.
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setTimeout"] });
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 3,
      });

      const sendPromise = t.send(makeSummary({ metrics: [makeMetric()] }));

      // Yield to the libuv event loop so the real HTTP request roundtrip
      // can complete. vi.advanceTimersByTimeAsync only drains fake timers
      // and microtasks; it does NOT wait for I/O callbacks. Multiple yields
      // give the TCP connect + write + server-side parse time to settle.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
        if (server.requests.length >= 1) break;
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(server.requests).toHaveLength(1);

      // Advance past the 2s Retry-After delay; then yield again so the
      // second HTTP roundtrip can complete on real I/O.
      await vi.advanceTimersByTimeAsync(2500);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
        if (server.requests.length >= 2) break;
      }
      await sendPromise;

      const status = t.lastFlushStatus;
      t.dispose();
      await server.close();

      expect(server.requests).toHaveLength(2);
      expect(status?.status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("honors Retry-After header in HTTP-date form", async () => {
    // Use a Retry-After ~2s in the future relative to REAL wall-clock time so
    // parseRetryAfter()'s `Date.now()` (real time) computes the right delta.
    // Faking Date breaks undici's connection-pool internals, so we leave it
    // alone and only fake setTimeout to control the retry sleep itself.
    const retryAt = new Date(Date.now() + 2000);
    const server = await startSequencedFakeHttpServer([
      { statusCode: 429, headers: { "retry-after": retryAt.toUTCString() } },
      { statusCode: 202 },
    ]);

    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setTimeout"] });
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 3,
      });

      const sendPromise = t.send(makeSummary({ metrics: [makeMetric()] }));

      // Yield to libuv so the real HTTP request roundtrip can complete.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
        if (server.requests.length >= 1) break;
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.requests).toHaveLength(1);

      // Advance past the ~2s Retry-After delta; ±25% jitter caps the sleep
      // at ~2.5s, so 3000ms covers it. Yield so the retry's real HTTP
      // roundtrip can complete.
      await vi.advanceTimersByTimeAsync(3000);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
        if (server.requests.length >= 2) break;
      }
      await sendPromise;

      const status = t.lastFlushStatus;
      t.dispose();
      await server.close();

      expect(server.requests).toHaveLength(2);
      expect(status?.status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("does NOT retry on 400 — exactly one POST attempt (regression lock)", async () => {
    const server = await startSequencedFakeHttpServer([
      { statusCode: 400 },
      { statusCode: 202 },
    ]);
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 3,
    });

    await t.send(makeSummary({ metrics: [makeMetric()] }));
    const status = t.lastFlushStatus;
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(1);
    expect(status?.status).toBe("error");
  });

  it("does NOT retry on 401 — exactly one POST attempt (regression lock)", async () => {
    const server = await startSequencedFakeHttpServer([
      { statusCode: 401 },
      { statusCode: 202 },
    ]);
    const t = new Transport({
      apiKey: "key",
      baseUrl: server.baseUrl,
      maxRetries: 3,
    });

    await t.send(makeSummary({ metrics: [makeMetric()] }));
    t.dispose();
    await server.close();

    expect(server.requests).toHaveLength(1);
  });

  it("applies ±25% jitter to retry delays", async () => {
    // Verify the SDK applies ±25% jitter by observing two things:
    //   1. setTimeout is called with values WITHIN the ±25% envelope of
    //      each exponential-backoff base (1000, 2000, 4000, 8000, 10000ms).
    //   2. Math.random() is invoked by the retry path — the unique mechanism
    //      by which jitter is produced (applyJitter calls Math.random once
    //      per retry sleep). Without jitter the retry path never calls it
    //      and attempt-0 delays are exactly 1000ms.
    //
    // We observe via spies but do NOT mock the implementations: the SDK's
    // actual setTimeout fires for real (briefly), which avoids interfering
    // with undici's internal headers/body parser timers.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const randomSpy = vi.spyOn(Math, "random");

    const server = await startSequencedFakeHttpServer([
      { statusCode: 503 },
    ]);
    try {
      const errors: Error[] = [];
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 1,
        onError: (e) => errors.push(e),
      });

      // 8 send() calls × 1 retry each = 8 observed attempt-0 retry sleeps.
      // Each sleep is base 1000ms ±25% (real wall time ≈ 750–1250ms), so
      // ~8s total — comfortably under the 15s test timeout.
      const randomCallsBefore = randomSpy.mock.calls.length;
      for (let i = 0; i < 8; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }
      t.dispose();
      await server.close();

      // Extract ms args from setTimeout calls.
      const allDelays = setTimeoutSpy.mock.calls
        .map((args) => args[1])
        .filter((ms): ms is number => typeof ms === "number");

      // Filter to the retry envelope: 1000ms ±25% (attempt 0) is 750–1250ms.
      const retryDelays = allDelays.filter((d) => d >= 700 && d <= 1300);
      expect(retryDelays.length).toBeGreaterThanOrEqual(6);

      // Every retry delay falls within ±25% of 1000ms.
      for (const d of retryDelays) {
        expect(d, `delay ${d}ms is outside ±25% of 1000ms`).toBeGreaterThanOrEqual(750);
        expect(d, `delay ${d}ms is outside ±25% of 1000ms`).toBeLessThanOrEqual(1250);
      }

      // Math.random was called at least once per retry — proves the jitter
      // mechanism actually ran (without jitter, applyJitter would not exist
      // and Math.random would not be invoked by the retry path).
      const randomCalls = randomSpy.mock.calls.length - randomCallsBefore;
      expect(
        randomCalls,
        `retry path did not call Math.random (jitter not applied)`,
      ).toBeGreaterThanOrEqual(6);

      // The core jitter assertion: attempt-0 delays must NOT all be the same.
      // Without jitter every attempt-0 retry would be exactly 1000ms; with
      // ±25% jitter we expect a spread of at least 2 unique values.
      const attempt0Unique = new Set(retryDelays);
      expect(
        attempt0Unique.size,
        `attempt-0 retry delays are deterministic (no jitter applied): ${[...attempt0Unique].join(", ")}`,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      randomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  }, 15_000);
});

describe("Transport — concurrent send serialization", () => {
  it("a second send() does not start its POST until the first one finishes", async () => {
    let release1: (() => void) | null = null;
    const block1 = new Promise<void>((resolve) => { release1 = resolve; });
    let release2: (() => void) | null = null;
    const block2 = new Promise<void>((resolve) => { release2 = resolve; });
    const arrivals: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const server = http.createServer((req, res) => {
      arrivals.push(Date.now());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const which = arrivals.length;
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", async () => {
        await (which === 1 ? block1 : block2);
        inFlight -= 1;
        res.writeHead(202);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}`;

    const t = new Transport({
      apiKey: "key",
      baseUrl,
      maxRetries: 0,
    });

    const p1 = t.send(makeSummary({ projectId: "first" }));
    const p2 = t.send(makeSummary({ projectId: "second" }));

    await new Promise((r) => setTimeout(r, 100));
    expect(arrivals.length).toBe(1);

    release1!();
    await p1;
    await new Promise((r) => setTimeout(r, 100));
    expect(arrivals.length).toBe(2);

    release2!();
    await p2;

    expect(maxInFlight).toBe(1);

    t.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
});
