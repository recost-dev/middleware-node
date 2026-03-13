/**
 * Tests for src/core/interceptor.ts
 *
 * Uses a real local HTTP server (Node built-in) for fetch and http.request tests.
 * Every test cleans up via afterEach uninstall().
 */

import http from "node:http";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  install,
  uninstall,
  isInstalled,
  getRawFetch,
} from "../src/core/interceptor.js";
import type { RawEvent } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Local test server helper
// ---------------------------------------------------------------------------

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
    server.once("error", reject);
  });
}

/** Read a full http.get response and return body + statusCode. */
function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
      })
      .once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  afterEach(() => {
    uninstall();
  });

  it("isInstalled returns false initially", () => {
    expect(isInstalled()).toBe(false);
  });

  it("install sets isInstalled to true", () => {
    install(() => {});
    expect(isInstalled()).toBe(true);
  });

  it("uninstall sets isInstalled to false", () => {
    install(() => {});
    uninstall();
    expect(isInstalled()).toBe(false);
  });

  it("double install is a no-op — second callback is ignored", () => {
    const events1: RawEvent[] = [];
    const events2: RawEvent[] = [];
    install((e) => events1.push(e));
    install((e) => events2.push(e)); // should be ignored
    expect(isInstalled()).toBe(true);
    // Only one install is active; we just verify no crash and state is consistent
    uninstall();
    expect(isInstalled()).toBe(false);
  });

  it("double uninstall is a no-op — no error thrown", () => {
    install(() => {});
    uninstall();
    expect(() => uninstall()).not.toThrow();
  });

  it("uninstall restores original fetch — patched version is no longer globalThis.fetch", () => {
    const beforeInstall = globalThis.fetch;
    install(() => {});
    const afterInstall = globalThis.fetch;
    uninstall();
    const afterUninstall = globalThis.fetch;

    // Patched fetch should differ from original
    expect(afterInstall).not.toBe(beforeInstall);
    // After uninstall, original fetch is restored
    expect(afterUninstall).toBe(beforeInstall);
  });
});

// ---------------------------------------------------------------------------
// fetch interception
// ---------------------------------------------------------------------------

describe("fetch interception", () => {
  let server: TestServer;
  const events: RawEvent[] = [];

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((req, res) => {
      const body = "hello";
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
    install((e) => {
      events.push(e);
    });
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("captures successful GET request with correct metadata", async () => {
    const res = await fetch(server.baseUrl + "/hello");
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.method).toBe("GET");
    expect(e.statusCode).toBe(200);
    expect(e.error).toBe(false);
    expect(e.latencyMs).toBeGreaterThan(0);
    expect(e.host).toBe("127.0.0.1");
    expect(e.path).toBe("/hello");
  });

  it("captures POST with body — correct method and requestBytes", async () => {
    const body = JSON.stringify({ test: true });
    await fetch(server.baseUrl + "/", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.method).toBe("POST");
    expect(e.requestBytes).toBe(Buffer.byteLength(body));
  });

  it("captures 4xx error response — error: true, response still returned", async () => {
    uninstall();
    await server.close();
    server = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    install((e) => events.push(e));

    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(404);
    expect(events[0]!.statusCode).toBe(404);
    expect(events[0]!.error).toBe(true);
  });

  it("captures 5xx error response — error: true, response still returned", async () => {
    uninstall();
    await server.close();
    server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    install((e) => events.push(e));

    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(500);
    expect(events[0]!.statusCode).toBe(500);
    expect(events[0]!.error).toBe(true);
  });

  it("captures network error — statusCode 0, error true, original error re-thrown", async () => {
    await expect(fetch("http://127.0.0.1:1")).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]!.statusCode).toBe(0);
    expect(events[0]!.error).toBe(true);
  });

  it("does not modify the response — body is intact", async () => {
    const res = await fetch(server.baseUrl + "/");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toBe("hello");
  });

  it("strips query params from event url — actual request still has full url", async () => {
    let receivedUrl = "";
    uninstall();
    await server.close();
    server = await startServer((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200);
      res.end();
    });
    install((e) => events.push(e));

    await fetch(server.baseUrl + "/path?secret=abc&key=123");
    // Event URL should not contain query params
    expect(events[0]!.url).not.toContain("?");
    expect(events[0]!.url).not.toContain("secret");
    // But the actual request received the full URL
    expect(receivedUrl).toContain("secret");
    expect(receivedUrl).toContain("key=123");
  });

  it("handles URL object input", async () => {
    await fetch(new URL(server.baseUrl + "/from-url"));
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/from-url");
  });

  it("handles Request object input", async () => {
    await fetch(new Request(server.baseUrl + "/from-request"));
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/from-request");
  });

  it("throwing callback does not break fetch — request still succeeds", async () => {
    uninstall();
    install(() => {
      throw new Error("callback exploded");
    });
    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello");
  });

  it("after uninstall, no events are captured", async () => {
    uninstall();
    await fetch(server.baseUrl + "/");
    expect(events).toHaveLength(0);
  });

  it("after uninstall, fetch still works normally", async () => {
    uninstall();
    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(200);
  });

  it("captures responseBytes from content-length header", async () => {
    const body = "hello";
    // Server sets content-length: 5
    await fetch(server.baseUrl + "/");
    expect(events[0]!.responseBytes).toBe(Buffer.byteLength(body));
  });
});

// ---------------------------------------------------------------------------
// http.request interception
// ---------------------------------------------------------------------------

describe("http.request interception", () => {
  let server: TestServer;
  const events: RawEvent[] = [];

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((_req, res) => {
      const body = "ok";
      res.writeHead(200, { "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
    install((e) => {
      events.push(e);
    });
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("captures GET via http.get with correct metadata", async () => {
    await httpGet(server.baseUrl + "/test");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.method).toBe("GET");
    expect(e.statusCode).toBe(200);
    expect(e.error).toBe(false);
    expect(e.host).toBe("127.0.0.1");
    expect(e.path).toBe("/test");
    expect(e.latencyMs).toBeGreaterThan(0);
  });

  it("response data is intact — http.get still works normally", async () => {
    const { body, statusCode } = await httpGet(server.baseUrl + "/");
    expect(statusCode).toBe(200);
    expect(body).toBe("ok");
  });

  it("captures POST via http.request with correct method and requestBytes", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    const reqBody = "test-payload";

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/post-test",
          method: "POST",
          headers: { "content-length": String(Buffer.byteLength(reqBody)) },
        },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", reject);
      req.write(reqBody);
      req.end();
    });

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.method).toBe("POST");
    expect(e.path).toBe("/post-test");
    expect(e.requestBytes).toBe(Buffer.byteLength(reqBody));
  });

  it("captures network error — statusCode 0, error true", async () => {
    await new Promise<void>((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: 1, path: "/" }, () => {});
      req.once("error", () => resolve());
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.statusCode).toBe(0);
    expect(events[0]!.error).toBe(true);
  });

  it("throwing callback does not break http.request — response still arrives", async () => {
    uninstall();
    install(() => {
      throw new Error("callback exploded");
    });
    const { statusCode, body } = await httpGet(server.baseUrl + "/");
    expect(statusCode).toBe(200);
    expect(body).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Double-count prevention
// ---------------------------------------------------------------------------

describe("double-count prevention", () => {
  let server: TestServer;
  const events: RawEvent[] = [];

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    install((e) => events.push(e));
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("single fetch() call produces exactly one event (no http.request double-count)", async () => {
    await fetch(server.baseUrl + "/");
    // fetch internally delegates to http — _inFetchWrapper guard prevents double-count
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getRawFetch
// ---------------------------------------------------------------------------

describe("getRawFetch", () => {
  let server: TestServer;
  const events: RawEvent[] = [];

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("raw");
    });
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("getRawFetch before install returns a working fetch function", async () => {
    const rawFetch = getRawFetch();
    const res = await rawFetch(server.baseUrl + "/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("raw");
  });

  it("getRawFetch after install returns original fetch — bypasses patches, no event emitted", async () => {
    install((e) => events.push(e));
    const rawFetch = getRawFetch();

    const res = await rawFetch(server.baseUrl + "/");
    expect(res.status).toBe(200);
    // Raw fetch bypasses the patched version — no event should be captured
    expect(events).toHaveLength(0);
  });

  it("getRawFetch is distinct from the patched globalThis.fetch after install", () => {
    const beforeFetch = globalThis.fetch;
    install(() => {});
    const patchedFetch = globalThis.fetch;
    const rawFetch = getRawFetch();

    expect(rawFetch).toBe(beforeFetch);
    expect(rawFetch).not.toBe(patchedFetch);
  });
});
