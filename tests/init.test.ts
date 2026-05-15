/**
 * Tests for src/init.ts
 *
 * Uses real HTTP and WebSocket servers to exercise the full init() pipeline
 * end-to-end: interceptor install, event enrichment, aggregation, and flush.
 */

import http from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { init } from "../src/init.js";
import { isInstalled, uninstall } from "../src/core/interceptor.js";
import type { WindowSummary } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestHttpServer {
  url: string;
  close(): Promise<void>;
}

function startHttpServer(
  handler: http.RequestListener = (_req, res) => { res.writeHead(200); res.end("ok"); },
): Promise<TestHttpServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            // Force-close keep-alive connections so server.close() doesn't hang
            if (typeof (server as unknown as { closeAllConnections?: () => void }).closeAllConnections === "function") {
              (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
            }
            server.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    server.once("error", reject);
  });
}

interface WsCollector {
  port: number;
  summaries: WindowSummary[];
  close(): Promise<void>;
}

function startWsCollector(): Promise<WsCollector> {
  return new Promise((resolve, reject) => {
    const summaries: WindowSummary[] = [];
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.once("listening", () => {
      const { port } = wss.address() as { port: number };
      wss.on("connection", (ws) => {
        ws.on("message", (data) => {
          try {
            summaries.push(JSON.parse(data.toString()) as WindowSummary);
          } catch {
            // ignore malformed
          }
        });
      });
      resolve({
        port,
        summaries,
        close: () =>
          new Promise<void>((res, rej) => {
            // Terminate all open clients first so wss.close() doesn't hang
            for (const client of wss.clients) client.terminate();
            wss.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    wss.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe("init — initialization", () => {
  afterEach(() => {
    uninstall();
  });

  it("installs interceptor", () => {
    const handle = init({ flushIntervalMs: 60_000 });
    expect(isInstalled()).toBe(true);
    handle.dispose();
  });

  it("enabled: false does not install interceptor", () => {
    const handle = init({ enabled: false });
    expect(isInstalled()).toBe(false);
    handle.dispose();
  });

  it("enabled: false returns a disposable no-op handle", () => {
    const handle = init({ enabled: false });
    expect(() => handle.dispose()).not.toThrow();
  });

  it("calling init() twice disposes the first instance — interceptor remains installed", () => {
    const h1 = init({ flushIntervalMs: 60_000 });
    const h2 = init({ flushIntervalMs: 60_000 }); // disposes h1
    expect(isInstalled()).toBe(true);
    h2.dispose();
    expect(isInstalled()).toBe(false);
  });

  it("dispose() uninstalls the interceptor", () => {
    const handle = init({ flushIntervalMs: 60_000 });
    expect(isInstalled()).toBe(true);
    handle.dispose();
    expect(isInstalled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event capture and enrichment
// ---------------------------------------------------------------------------

describe("init — event capture and enrichment", () => {
  afterEach(() => {
    uninstall();
  });

  it("captures a fetch request and enriches it with a matched provider", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    // Register the local test server as a known provider via customProviders
    const handle = init({
      localPort: ws.port,
      flushIntervalMs: 100,
      customProviders: [
        {
          hostPattern: "127.0.0.1",
          provider: "test-provider",
          endpointCategory: "test-api",
          costPerRequestCents: 0.5,
        },
      ],
    });

    await fetch(httpServer.url + "/api").catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    expect(ws.summaries.length).toBeGreaterThan(0);
    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    const metric = allMetrics.find((m) => m.provider === "test-provider");
    expect(metric).toBeDefined();
    expect(metric!.endpoint).toBe("test-api");
  });

  it("unrecognized URLs are grouped under provider 'unknown'", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({ localPort: ws.port, flushIntervalMs: 100 });

    await fetch(httpServer.url + "/some/path").catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    const metric = allMetrics.find((m) => m.provider === "unknown");
    expect(metric).toBeDefined();
  });

  it("captures http.request as well as fetch", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({ localPort: ws.port, flushIntervalMs: 100 });

    const port = parseInt(httpServer.url.split(":")[2]!, 10);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/http-req", method: "GET" },
        (res) => { res.resume(); res.once("close", resolve); },
      );
      req.once("error", reject);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    expect(allMetrics.length).toBeGreaterThan(0);
    const match = allMetrics.find((m) => m.endpoint === "/http-req");
    expect(match).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Exclude patterns
// ---------------------------------------------------------------------------

describe("init — exclude patterns", () => {
  afterEach(() => {
    uninstall();
  });

  it("excludes URLs matching a custom excludePattern", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({
      localPort: ws.port,
      flushIntervalMs: 100,
      excludePatterns: ["/health"],
    });

    // Excluded request
    await fetch(httpServer.url + "/health").catch(() => {});
    // Captured request
    await fetch(httpServer.url + "/api/data").catch(() => {});

    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    // /health should be excluded; /api/data should appear
    const healthMetric = allMetrics.find((m) => m.endpoint === "/health");
    const apiMetric = allMetrics.find((m) => m.endpoint === "/api/data");
    expect(healthMetric).toBeUndefined();
    expect(apiMetric).toBeDefined();
  });

  it("auto-excludes the transport's own WebSocket port", async () => {
    const ws = await startWsCollector();
    const otherServer = await startHttpServer();

    const handle = init({ localPort: ws.port, flushIntervalMs: 100 });

    // Fetch to the WS port (should be auto-excluded)
    await fetch(`http://127.0.0.1:${ws.port}/probe`).catch(() => {});
    // Fetch to a different server (should be captured)
    await fetch(otherServer.url + "/tracked").catch(() => {});

    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await otherServer.close();
    await ws.close();

    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    // No metric should reference the WS server's port in its URL
    const wsPortMetric = allMetrics.find((m) =>
      m.endpoint.includes(String(ws.port)),
    );
    expect(wsPortMetric).toBeUndefined();
    // The /tracked request should appear
    const tracked = allMetrics.find((m) => m.endpoint === "/tracked");
    expect(tracked).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Flush behavior
// ---------------------------------------------------------------------------

describe("init — flush behavior", () => {
  afterEach(() => {
    uninstall();
  });

  it("flushes on the configured interval", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({ localPort: ws.port, flushIntervalMs: 150 });

    await fetch(httpServer.url + "/data").catch(() => {});

    // Wait longer than the flush interval
    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    expect(ws.summaries.length).toBeGreaterThan(0);
  });

  it("triggers an early flush when maxBatchSize is reached", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({
      localPort: ws.port,
      flushIntervalMs: 60_000, // very long — won't fire during test
      maxBatchSize: 3,
    });

    // Fire exactly maxBatchSize requests in parallel
    await Promise.all([
      fetch(httpServer.url + "/r1").catch(() => {}),
      fetch(httpServer.url + "/r2").catch(() => {}),
      fetch(httpServer.url + "/r3").catch(() => {}),
    ]);

    // Give time for the early flush to complete
    await new Promise((r) => setTimeout(r, 300));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    // Flush should have fired before the 60s interval
    expect(ws.summaries.length).toBeGreaterThan(0);
    const totalRequests = ws.summaries
      .flatMap((s) => s.metrics)
      .reduce((sum, m) => sum + m.requestCount, 0);
    expect(totalRequests).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("init — dispose", () => {
  afterEach(() => {
    uninstall();
  });

  it("dispose stops capturing new events", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({ localPort: ws.port, flushIntervalMs: 100 });
    handle.dispose();

    // Make requests after dispose — should NOT be captured
    await fetch(httpServer.url + "/after-dispose").catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    await httpServer.close();
    await ws.close();

    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    const afterDisposeMetric = allMetrics.find((m) => m.endpoint === "/after-dispose");
    expect(afterDisposeMetric).toBeUndefined();
  });

  it("dispose fires a final flush so the in-progress window isn't dropped", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    // Long flush interval so the periodic flush definitely won't fire during
    // the test — anything we receive must be the dispose-time shutdown flush.
    const handle = init({ localPort: ws.port, flushIntervalMs: 60_000, maxBatchSize: 1000 });

    await fetch(httpServer.url + "/pre-dispose").catch(() => {});
    // Give the WS connection a beat to be ready before dispose triggers the
    // shutdown flush (otherwise the payload would queue and never deliver
    // because dispose() closes the socket once the flush promise settles).
    await new Promise((r) => setTimeout(r, 100));

    await handle.dispose();

    // The flush is fire-and-forget over the WebSocket — give the server a
    // brief window to actually receive the bytes before we tear it down.
    for (let i = 0; i < 50; i++) {
      if (ws.summaries.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    await httpServer.close();
    await ws.close();

    // The shutdown flush must have shipped the captured event.
    const allMetrics = ws.summaries.flatMap((s) => s.metrics);
    const captured = allMetrics.find((m) => m.endpoint === "/pre-dispose");
    expect(captured).toBeDefined();
  });

  it("dispose is safe to call multiple times", () => {
    const handle = init({ flushIntervalMs: 60_000 });
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Config forwarding
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// lastFlushStatus
// ---------------------------------------------------------------------------

describe("init — lastFlushStatus", () => {
  afterEach(() => {
    uninstall();
  });

  it("is null before any flush has completed", () => {
    const handle = init({ flushIntervalMs: 60_000 });
    expect(handle.lastFlushStatus).toBeNull();
    handle.dispose();
  });

  it("returns null from a disabled-mode handle", () => {
    const handle = init({ enabled: false });
    expect(handle.lastFlushStatus).toBeNull();
    handle.dispose();
  });

  it("reflects a successful flush outcome", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({ localPort: ws.port, flushIntervalMs: 100 });

    await fetch(httpServer.url + "/tracked").catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    const status = handle.lastFlushStatus;
    handle.dispose();
    await httpServer.close();
    await ws.close();

    expect(status).not.toBeNull();
    expect(status!.status).toBe("ok");
    expect(status!.windowSize).toBeGreaterThan(0);
    expect(typeof status!.timestamp).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Bucket overflow → early flush (silent data loss prevention)
// ---------------------------------------------------------------------------

describe("init — bucket overflow protection", () => {
  afterEach(() => {
    uninstall();
  });

  it("hitting maxBuckets mid-window triggers an early flush instead of dropping data", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    // Tiny cap so we can force overflow with a handful of requests
    const handle = init({
      localPort: ws.port,
      flushIntervalMs: 60_000,
      maxBatchSize: 10_000, // make sure batch-size flush doesn't mask overflow flush
      maxBuckets: 3,
    });

    // 4 distinct paths → 4 unique (provider, endpoint, method) triplets
    for (const p of ["/a", "/b", "/c", "/d"]) {
      await fetch(httpServer.url + p).catch(() => {});
    }

    // Give overflow flush time to ship
    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    // A flush must have occurred — proving data was preserved, not dropped
    expect(ws.summaries.length).toBeGreaterThan(0);
    const totalBuckets = ws.summaries.reduce((sum, s) => sum + s.metrics.length, 0);
    // The first three unique endpoints were flushed before the 4th could overflow
    expect(totalBuckets).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Flush interval resilience
//
// Regression: setInterval(() => flushAndSend().catch(...)) will die permanently
// if anything throws synchronously out of the interval callback. The interval
// body must be wrapped in try/catch so telemetry keeps flowing for the life
// of the process even if a flush unexpectedly throws.
// ---------------------------------------------------------------------------

describe("init — flush interval resilience", () => {
  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
  });

  it("captured setInterval callback never propagates a synchronous throw", () => {
    let intervalCb: (() => void) | null = null;

    vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => void) => {
      intervalCb = cb;
      // Return a handle that supports .unref() (init calls it) but never fires
      return { unref: () => {}, ref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof globalThis.setInterval);

    const handle = init({ flushIntervalMs: 100 });

    expect(intervalCb).not.toBeNull();

    // Invoking the interval body repeatedly must never throw. If the outer
    // try/catch were missing and something threw synchronously on any tick,
    // the exception would propagate and Node would kill the interval.
    for (let i = 0; i < 10; i++) {
      expect(() => intervalCb!()).not.toThrow();
    }

    handle.dispose();
  });

  it("subsequent interval ticks still fire after a failing flush", async () => {
    let intervalCb: (() => void) | null = null;

    vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => void) => {
      intervalCb = cb;
      return { unref: () => {}, ref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof globalThis.setInterval);

    const errors: Error[] = [];
    // Force the cloud transport to reject by pointing at an unreachable host.
    // flushAndSend will resolve to nothing (no aggregated data yet) on the
    // first tick, but even if send() were to throw/reject, the interval must
    // continue firing on subsequent ticks.
    const handle = init({
      apiKey: "rc-test-key",
      projectId: "proj_1",
      baseUrl: "https://127.0.0.1:1",
      flushIntervalMs: 60_000,
      onError: (err) => errors.push(err),
    });

    expect(intervalCb).not.toBeNull();

    // Fire the interval many times in a row. Even if an individual tick hit
    // an error, the callback itself must never propagate an exception.
    for (let i = 0; i < 5; i++) {
      expect(() => intervalCb!()).not.toThrow();
    }

    // Drain any pending microtasks triggered by the async .catch handlers
    await new Promise((r) => setImmediate(r));

    handle.dispose();
  });

  it("a throwing onError handler does not kill subsequent interval invocations", async () => {
    let intervalCb: (() => void) | null = null;

    vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => void) => {
      intervalCb = cb;
      return { unref: () => {}, ref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof globalThis.setInterval);

    // onError throws — this can only happen inside the rejected-promise
    // microtask, not the interval callback itself, but we still want to
    // confirm that regardless, invoking the interval repeatedly is safe.
    const handle = init({
      apiKey: "rc-test-key",
      projectId: "proj_1",
      baseUrl: "https://127.0.0.1:1",
      flushIntervalMs: 60_000,
      onError: () => {
        throw new Error("user's onError exploded");
      },
    });

    expect(intervalCb).not.toBeNull();

    for (let i = 0; i < 3; i++) {
      expect(() => intervalCb!()).not.toThrow();
    }

    // Swallow any unhandled rejections from the throwing onError by draining
    // microtasks before the test finishes.
    await new Promise((r) => setImmediate(r));

    handle.dispose();
  });
});

describe("init — config forwarding", () => {
  afterEach(() => {
    uninstall();
  });

  it("forwards environment to the WindowSummary", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    const handle = init({
      localPort: ws.port,
      flushIntervalMs: 100,
      projectId: "my-project",
      environment: "staging",
    });

    await fetch(httpServer.url + "/test").catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    handle.dispose();
    await httpServer.close();
    await ws.close();

    expect(ws.summaries.length).toBeGreaterThan(0);
    const summary = ws.summaries[0]!;
    expect(summary.environment).toBe("staging");
    expect(summary.sdkLanguage).toBe("node");
  });
});

// ---------------------------------------------------------------------------
// Config validation — gates side effects on bad input
//
// Regression risk: validateConfig must run BEFORE install(), setInterval(),
// or `new Transport(...)`. If a future refactor moves these earlier,
// throwing init() calls would leave a half-initialized SDK behind:
// patched globalThis.fetch, leaked timer, dangling WebSocket. The tests
// pin the contract by checking isInstalled() === false after the throw.
// ---------------------------------------------------------------------------

describe("init — config validation", () => {
  afterEach(() => {
    uninstall();
  });

  it("throws when apiKey is set without a projectId", () => {
    expect(() => init({ apiKey: "rc-abc123" })).toThrow(
      /projectId is required when apiKey is set/,
    );
    expect(isInstalled()).toBe(false);
  });

  it("throws when apiKey is set with an empty projectId", () => {
    expect(() => init({ apiKey: "rc-abc123", projectId: "" })).toThrow(
      /projectId is required when apiKey is set/,
    );
    expect(isInstalled()).toBe(false);
  });

  it("throws when apiKey does not have the 'rc-' prefix", () => {
    expect(() => init({ apiKey: "sk-something", projectId: "proj_1" })).toThrow(
      /apiKey must be a string beginning with "rc-"/,
    );
    expect(isInstalled()).toBe(false);
  });

  it("throws when apiKey is the literal string 'undefined' (env-misread footgun)", () => {
    expect(() => init({ apiKey: "undefined", projectId: "proj_1" })).toThrow(
      /apiKey must be a string beginning with "rc-"/,
    );
    expect(isInstalled()).toBe(false);
  });

  it("accepts a valid cloud-mode config without throwing", () => {
    const handle = init({ apiKey: "rc-abc123", projectId: "proj_1", flushIntervalMs: 60_000 });
    expect(isInstalled()).toBe(true);
    handle.dispose();
  });

  it("local mode (no apiKey) still works without a projectId", () => {
    const handle = init({ flushIntervalMs: 60_000 });
    expect(isInstalled()).toBe(true);
    handle.dispose();
  });

  it("a throwing init() does not leave a stale module-level handle that would dispose a later init", () => {
    // Scenario: first init() throws. Second init() with valid config should
    // run cleanly without trying to dispose() something that never existed.
    expect(() => init({ apiKey: "bad" })).toThrow();
    const handle = init({ flushIntervalMs: 60_000 });
    expect(isInstalled()).toBe(true);
    handle.dispose();
    expect(isInstalled()).toBe(false);
  });
});
