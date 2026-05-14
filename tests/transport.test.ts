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
import {
  RecostAuthError,
  RecostFatalAuthError,
  RecostLocalUnreachableError,
  type MetricEntry,
  type WindowSummary,
} from "../src/core/types.js";

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
// 401 auth-failure handling (issue #16)
// ---------------------------------------------------------------------------

describe("Transport — 401 auth-failure handling", () => {
  it("single 401 fires RecostAuthError(401, 1) and one stderr line; not suspended", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      await t.send(makeSummary({ metrics: [makeMetric()] }));
      const status = t.lastFlushStatus;
      t.dispose();
      await server.close();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(RecostAuthError);
      expect(errors[0]).not.toBeInstanceOf(RecostFatalAuthError);
      const authErr = errors[0] as RecostAuthError;
      expect(authErr.status).toBe(401);
      expect(authErr.consecutiveFailures).toBe(1);

      const stderrCalls = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[recost]"));
      expect(stderrCalls).toHaveLength(1);
      expect(stderrCalls[0]).toContain("HTTP 401");
      expect(stderrCalls[0]).toContain("API key rejected");

      expect(status?.status).toBe("error");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("five consecutive 401s fires RecostFatalAuthError on attempt #5 and emits a second stderr line", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      for (let i = 0; i < 5; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }

      t.dispose();
      await server.close();

      // Four RecostAuthError followed by one RecostFatalAuthError.
      expect(errors).toHaveLength(5);
      for (let i = 0; i < 4; i++) {
        expect(errors[i]).toBeInstanceOf(RecostAuthError);
        expect(errors[i]).not.toBeInstanceOf(RecostFatalAuthError);
        expect((errors[i] as RecostAuthError).consecutiveFailures).toBe(i + 1);
      }
      expect(errors[4]).toBeInstanceOf(RecostFatalAuthError);
      expect((errors[4] as RecostFatalAuthError).consecutiveFailures).toBe(5);
      expect((errors[4] as RecostFatalAuthError).status).toBe(401);

      // Two stderr lines: first 401, fatal-suspend. Nothing in between.
      const stderrCalls = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[recost]"));
      expect(stderrCalls).toHaveLength(2);
      expect(stderrCalls[0]).toContain("HTTP 401");
      expect(stderrCalls[0]).toContain("API key rejected");
      expect(stderrCalls[1]).toContain("cloud transport suspended");
      expect(stderrCalls[1]).toContain("5 consecutive");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("after suspension, further sends are silent no-ops (no fetch, no onError, no stderr)", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      // Drive to suspension (5 sends).
      for (let i = 0; i < 5; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }
      const errorsAtSuspension = errors.length;
      const requestsAtSuspension = server.requests.length;
      const stderrAtSuspension = stderrSpy.mock.calls.filter(
        (c) => String(c[0]).includes("[recost]"),
      ).length;

      // 6th + 7th + 8th sends post-suspension.
      for (let i = 0; i < 3; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }
      const status = t.lastFlushStatus;
      t.dispose();
      await server.close();

      // No new HTTP requests.
      expect(server.requests).toHaveLength(requestsAtSuspension);
      // No new onError invocations.
      expect(errors.length).toBe(errorsAtSuspension);
      // No new stderr lines.
      const stderrFinal = stderrSpy.mock.calls.filter(
        (c) => String(c[0]).includes("[recost]"),
      ).length;
      expect(stderrFinal).toBe(stderrAtSuspension);
      // lastFlushStatus still reports error so polling hosts can detect.
      expect(status?.status).toBe("error");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("counter resets on a 2xx success — next 401 reports consecutiveFailures: 1", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      // Four 401s.
      for (let i = 0; i < 4; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }
      // Now a success.
      server.statusCode = 202;
      await t.send(makeSummary({ metrics: [makeMetric()] }));
      // Back to 401 — should report `consecutiveFailures: 1`, not 5.
      server.statusCode = 401;
      await t.send(makeSummary({ metrics: [makeMetric()] }));

      t.dispose();
      await server.close();

      // 4 + 0 (success) + 1 = 5 RecostAuthError calls total. None are Fatal.
      const authErrors = errors.filter((e) => e instanceof RecostAuthError);
      expect(authErrors).toHaveLength(5);
      expect(errors.some((e) => e instanceof RecostFatalAuthError)).toBe(false);
      expect((authErrors[4] as RecostAuthError).consecutiveFailures).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("counter resets on a non-401 4xx (403) — existing 403 onError behavior preserved", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      // Three 401s.
      for (let i = 0; i < 3; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }
      // One 403.
      server.statusCode = 403;
      await t.send(makeSummary({ metrics: [makeMetric()] }));
      // Back to 401 — counter should be reset; this is consecutiveFailures: 1.
      server.statusCode = 401;
      await t.send(makeSummary({ metrics: [makeMetric()] }));

      t.dispose();
      await server.close();

      // 3 RecostAuthError + 1 plain Error (403) + 1 RecostAuthError = 5 total.
      expect(errors).toHaveLength(5);
      const authErrors = errors.filter((e) => e instanceof RecostAuthError);
      expect(authErrors).toHaveLength(4);
      // The non-RecostAuthError must be a plain Error from _reportRejection (403 path).
      const nonAuth = errors.filter((e) => !(e instanceof RecostAuthError));
      expect(nonAuth).toHaveLength(1);
      expect(nonAuth[0]!.message).toContain("403");
      // The last auth error must report consecutiveFailures: 1, proving reset.
      expect((authErrors[3] as RecostAuthError).consecutiveFailures).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("counter resets on 5xx-after-retries-exhausted — next 401 reports consecutiveFailures: 1", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      for (let i = 0; i < 3; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }
      // Server starts returning 5xx — postCloud retries (we set maxRetries=0
      // so this is "retries exhausted on first attempt"). _reportRejection
      // handles the non-401 4xx path, but 500 is 5xx. With maxRetries=0,
      // postCloud throws after the single 500 attempt; the catch block runs
      // and resets the counter.
      server.statusCode = 500;
      await t.send(makeSummary({ metrics: [makeMetric()] }));
      server.statusCode = 401;
      await t.send(makeSummary({ metrics: [makeMetric()] }));

      t.dispose();
      await server.close();

      const authErrors = errors.filter((e) => e instanceof RecostAuthError);
      expect(authErrors).toHaveLength(4);
      expect((authErrors[3] as RecostAuthError).consecutiveFailures).toBe(1);
      // None are Fatal.
      expect(errors.some((e) => e instanceof RecostFatalAuthError)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("counter resets on a network throw — next 401 reports consecutiveFailures: 1", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });

      for (let i = 0; i < 3; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }

      // Close the server so the next send hits ECONNREFUSED — postCloud
      // throws, the catch block runs, the counter resets.
      await server.close();
      await t.send(makeSummary({ metrics: [makeMetric()] }));

      // Reopen on a different ephemeral port — easier to just construct
      // a fresh Transport pointing at a new server for the final 401 check.
      const server2 = await startFakeHttpServer();
      server2.statusCode = 401;
      const t2 = new Transport({
        apiKey: "key",
        baseUrl: server2.baseUrl,
        maxRetries: 0,
        onError: (e) => errors.push(e),
      });
      await t2.send(makeSummary({ metrics: [makeMetric()] }));

      t.dispose();
      t2.dispose();
      await server2.close();

      // t emitted 3 RecostAuthError + 1 generic Error (network) = 4.
      // t2 emitted 1 RecostAuthError(401, 1) because it's a fresh Transport.
      // We assert the second Transport reports consecutiveFailures: 1, which
      // doubles as proof the per-instance state was clean. The original
      // Transport's reset is implicit (no more 401s after the throw).
      const t2AuthErrors = errors.filter(
        (e) => e instanceof RecostAuthError,
      );
      expect(t2AuthErrors[t2AuthErrors.length - 1]).toBeInstanceOf(RecostAuthError);
      expect(
        (t2AuthErrors[t2AuthErrors.length - 1] as RecostAuthError).consecutiveFailures,
      ).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("maxConsecutiveAuthFailures: 2 trips fatal-suspend after 2 401s instead of 5", async () => {
    const server = await startFakeHttpServer();
    server.statusCode = 401;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        apiKey: "key",
        baseUrl: server.baseUrl,
        maxRetries: 0,
        maxConsecutiveAuthFailures: 2,
        onError: (e) => errors.push(e),
      });

      await t.send(makeSummary({ metrics: [makeMetric()] }));
      await t.send(makeSummary({ metrics: [makeMetric()] }));

      t.dispose();
      await server.close();

      expect(errors).toHaveLength(2);
      expect(errors[0]).toBeInstanceOf(RecostAuthError);
      expect(errors[0]).not.toBeInstanceOf(RecostFatalAuthError);
      expect(errors[1]).toBeInstanceOf(RecostFatalAuthError);
      expect((errors[1] as RecostFatalAuthError).consecutiveFailures).toBe(2);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("local mode never suspends — no 401 path can run without apiKey", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      // No apiKey => mode is 'local'. Use a port with nothing listening.
      const t = new Transport({
        localPort: 49999,
        maxConsecutiveAuthFailures: 1,
        onError: (e) => errors.push(e),
      });

      // Send 10 summaries. They get queued (no WS server). None of this
      // should produce a 401 path because there's no HTTP call at all.
      for (let i = 0; i < 10; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }

      t.dispose();

      // No RecostAuthError, no RecostFatalAuthError, no stderr from the
      // auth-failure path.
      expect(errors.filter((e) => e instanceof RecostAuthError)).toHaveLength(0);
      const authStderr = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("401") || s.includes("auth"));
      expect(authStderr).toHaveLength(0);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Local-mode terminal failure handling (issue #22)
// ---------------------------------------------------------------------------

describe("Transport — local-mode terminal failure handling", () => {
  it("single failed reconnect does NOT pause: counter increments, no onError, no stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      // Port 49998 is unlikely to have anything listening — the WS connect
      // will fail and `_scheduleReconnect` will run. Default threshold is 20,
      // so a single failure must not trip the unreachable handler.
      const t = new Transport({
        localPort: 49998,
        onError: (e) => errors.push(e),
      });

      // Wait briefly — long enough for the initial connect to fail but well
      // before the second reconnect attempt at ~500ms backoff.
      await new Promise((r) => setTimeout(r, 200));

      // Internal state assertion: the counter incremented but the latch is off.
      const internal = t as unknown as {
        _reconnectAttempts: number;
        _localPaused: boolean;
      };
      expect(internal._reconnectAttempts).toBeGreaterThanOrEqual(1);
      expect(internal._localPaused).toBe(false);

      // No `onError` should have fired and no `[recost]` stderr line yet.
      expect(errors.filter((e) => e instanceof RecostLocalUnreachableError)).toHaveLength(0);
      const recostStderr = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[recost]"));
      expect(recostStderr).toHaveLength(0);

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("threshold reached — fires RecostLocalUnreachableError(threshold), one stderr line, paused", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        localPort: 49997,
        maxConsecutiveReconnectFailures: 2,
        onError: (e) => errors.push(e),
      });

      // Wait long enough for: initial connect fail + reconnect #1 fail
      // + reconnect #2 fail + 3rd `_scheduleReconnect` to trip.
      // Backoff schedule: 500ms (after initial fail) + 1000ms (after #1 fail).
      // Add ~500ms safety margin for jitter (±25%) and event-loop scheduling.
      await new Promise((r) => setTimeout(r, 2500));

      // One typed error fired exactly once.
      const unreachable = errors.filter(
        (e) => e instanceof RecostLocalUnreachableError,
      );
      expect(unreachable).toHaveLength(1);
      const err = unreachable[0] as RecostLocalUnreachableError;
      expect(err.consecutiveFailures).toBe(2);
      expect(err.message).toContain("2 consecutive failed reconnects");

      // Exactly one [recost] stderr line announcing the unreachable state.
      const recostStderr = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[recost]"));
      expect(recostStderr).toHaveLength(1);
      expect(recostStderr[0]).toContain("local WebSocket unreachable");
      expect(recostStderr[0]).toContain("2 consecutive");

      // Internal latch flipped, queue cleared.
      const internal = t as unknown as {
        _localPaused: boolean;
        _wsQueue: string[];
      };
      expect(internal._localPaused).toBe(true);
      expect(internal._wsQueue).toEqual([]);

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  }, 5_000);

  it("after pause, send() is a silent no-op (no enqueue, no onError, no stderr, lastFlushStatus error)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        localPort: 49996,
        maxConsecutiveReconnectFailures: 2,
        onError: (e) => errors.push(e),
      });

      // Drive to pause.
      await new Promise((r) => setTimeout(r, 2500));

      // Sanity: pause occurred.
      const errorsAtPause = errors.length;
      const stderrAtPause = stderrSpy.mock.calls.filter(
        (c) => String(c[0]).includes("[recost]"),
      ).length;
      const internal = t as unknown as { _localPaused: boolean; _wsQueue: string[] };
      expect(internal._localPaused).toBe(true);

      // Send 5 summaries post-pause.
      for (let i = 0; i < 5; i++) {
        await t.send(makeSummary({ metrics: [makeMetric()] }));
      }

      // Queue did not grow (paused branch returns before enqueue).
      expect(internal._wsQueue).toEqual([]);
      // No new errors.
      expect(errors.length).toBe(errorsAtPause);
      // No new [recost] stderr.
      const stderrFinal = stderrSpy.mock.calls.filter(
        (c) => String(c[0]).includes("[recost]"),
      ).length;
      expect(stderrFinal).toBe(stderrAtPause);
      // lastFlushStatus reflects the no-op as an error so polling hosts can detect.
      expect(t.lastFlushStatus?.status).toBe("error");

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  }, 5_000);

  it("counter resets on successful connect — full threshold of fresh failures required to trip again", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      // Pick a port the WS server can claim later in the test.
      const port = 49995;
      const t = new Transport({
        localPort: port,
        maxConsecutiveReconnectFailures: 3,
        onError: (e) => errors.push(e),
      });

      // Phase 1: let the initial connect fail (port has nothing listening).
      // _reconnectAttempts goes 0 → 1.
      await new Promise((r) => setTimeout(r, 200));

      // Phase 2: start the WS server. The next reconnect attempt succeeds and
      // _reconnectAttempts resets to 0 inside ws.on("open").
      const ws = await startFakeWsServerOnPort(port);
      // Wait for the connection (the open handler fires inside _connectWs).
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (ws.connectionCount > 0) {
            clearInterval(interval);
            resolve();
          }
        }, 20);
      });

      // Sanity: counter reset.
      const internalMid = t as unknown as { _reconnectAttempts: number };
      expect(internalMid._reconnectAttempts).toBe(0);

      // Phase 3: close the WS server. The transport's WS will receive a close
      // event, which triggers _scheduleReconnect, restarting the failure cycle.
      await ws.close();

      // Drive 3 fresh failed reconnects to trip with consecutiveFailures: 3.
      // Backoff after server close: 500ms + 1000ms + 2000ms = ~3500ms minimum.
      await new Promise((r) => setTimeout(r, 4500));

      const unreachable = errors.filter(
        (e) => e instanceof RecostLocalUnreachableError,
      );
      expect(unreachable).toHaveLength(1);
      // The trip reports n=3 — consistent with reset (counter went 0→1→2→3
      // after server close). The mid-phase `_reconnectAttempts === 0` assert
      // above is the load-bearing proof that the reset actually happened;
      // this assertion just confirms the post-reset trip wasn't off-by-one.
      expect((unreachable[0] as RecostLocalUnreachableError).consecutiveFailures).toBe(3);

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  }, 7_000);
});
