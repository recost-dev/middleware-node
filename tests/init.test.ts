/**
 * Tests for src/init.ts
 *
 * Uses real HTTP and WebSocket servers to exercise the full init() pipeline
 * end-to-end: interceptor install, event enrichment, aggregation, and flush.
 */

import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
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

  it("dispose does not fire a final flush — remaining events are dropped", async () => {
    const ws = await startWsCollector();
    const httpServer = await startHttpServer();

    // Long flush interval so auto-flush won't trigger
    const handle = init({ localPort: ws.port, flushIntervalMs: 60_000, maxBatchSize: 1000 });

    await fetch(httpServer.url + "/pre-dispose").catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    // Dispose before flush fires — current impl does NOT flush on dispose
    handle.dispose();
    await new Promise((r) => setTimeout(r, 200));

    await httpServer.close();
    await ws.close();

    // With current implementation, dispose does not flush.
    // This is expected behavior — no summary should have been sent after dispose.
    // (If a future implementation adds final flush, this test should be updated.)
    expect(ws.summaries.length).toBe(0);
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

describe("init — config forwarding", () => {
  afterEach(() => {
    uninstall();
  });

  it("forwards projectId and environment to the WindowSummary", async () => {
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
    expect(summary.projectId).toBe("my-project");
    expect(summary.environment).toBe("staging");
    expect(summary.sdkLanguage).toBe("node");
  });
});
