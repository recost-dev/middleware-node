/**
 * Tests for src/core/interceptor.ts
 *
 * Uses a real local HTTP server (Node built-in) for fetch and http.request tests.
 * Every test cleans up via afterEach uninstall().
 */

import http from "node:http";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { install, uninstall, isInstalled } from "../src/core/interceptor.js";
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
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
    server.once("error", reject);
  });
}

/** Make a http.request and return a promise that resolves with the response body. */
function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    }).once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe("install / uninstall lifecycle", () => {
  afterEach(() => { uninstall(); });

  it("isInstalled() returns false before install", () => {
    expect(isInstalled()).toBe(false);
  });

  it("isInstalled() returns true after install", () => {
    install(() => {});
    expect(isInstalled()).toBe(true);
  });

  it("isInstalled() returns false after uninstall", () => {
    install(() => {});
    uninstall();
    expect(isInstalled()).toBe(false);
  });

  it("double install() is a no-op — callback is not replaced", () => {
    const cb1 = () => {};
    const cb2 = () => {};
    install(cb1);
    install(cb2); // should be ignored
    expect(isInstalled()).toBe(true);
    uninstall();
    // No crash, no double-patch
  });

  it("double uninstall() is a no-op — no error", () => {
    install(() => {});
    uninstall();
    expect(() => uninstall()).not.toThrow();
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
    install((e) => { events.push(e); });
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("captures a GET request with correct metadata", async () => {
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

  it("returns the original response unmodified", async () => {
    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello");
  });

  it("captures correct method and requestBytes for POST with body", async () => {
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

  it("captures error: true for 5xx responses", async () => {
    uninstall();
    await server.close();
    server = await startServer((_req, res) => { res.writeHead(500); res.end(); });
    install((e) => { events.push(e); });

    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(500);
    expect(events[0]!.error).toBe(true);
    expect(events[0]!.statusCode).toBe(500);
  });

  it("still returns the response on error status", async () => {
    uninstall();
    await server.close();
    server = await startServer((_req, res) => { res.writeHead(404); res.end(); });
    install((e) => { events.push(e); });

    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(404); // response still returned, not swallowed
  });

  it("captures network error with statusCode 0 and re-throws", async () => {
    // Point at a port with no server
    await expect(fetch("http://127.0.0.1:1")).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]!.statusCode).toBe(0);
    expect(events[0]!.error).toBe(true);
  });

  it("does not double-count fetch (exactly 1 event per fetch call)", async () => {
    await fetch(server.baseUrl + "/");
    expect(events).toHaveLength(1);
  });

  it("strips query params from event url but sends full url to server", async () => {
    let receivedUrl = "";
    uninstall();
    await server.close();
    server = await startServer((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200); res.end();
    });
    install((e) => { events.push(e); });

    await fetch(server.baseUrl + "/path?secret=abc&key=123");
    expect(events[0]!.url).not.toContain("?");
    expect(events[0]!.url).not.toContain("secret");
    expect(receivedUrl).toContain("secret"); // original request not modified
  });

  it("works with URL object as input", async () => {
    await fetch(new URL(server.baseUrl + "/from-url"));
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/from-url");
  });

  it("works with Request object as input", async () => {
    await fetch(new Request(server.baseUrl + "/from-request"));
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/from-request");
  });

  it("does not fail when callback throws — request still succeeds", async () => {
    uninstall();
    install(() => { throw new Error("callback exploded"); });
    const res = await fetch(server.baseUrl + "/");
    expect(res.status).toBe(200); // request was not broken
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
});

// ---------------------------------------------------------------------------
// http.request interception
// ---------------------------------------------------------------------------

describe("http.request interception", () => {
  let server: TestServer;
  const events: RawEvent[] = [];

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((req, res) => {
      const body = "ok";
      res.writeHead(200, { "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
    install((e) => { events.push(e); });
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("captures a GET via http.get", async () => {
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

  it("captures a POST via http.request with body", async () => {
    await new Promise<void>((resolve, reject) => {
      const reqBody = "test-payload";
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: parseInt(server.baseUrl.split(":")[2]!),
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
    expect(e.requestBytes).toBe(Buffer.byteLength("test-payload"));
  });

  it("captures http.request network error", async () => {
    await new Promise<void>((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: 1, path: "/" }, () => {});
      req.once("error", () => resolve());
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.statusCode).toBe(0);
    expect(events[0]!.error).toBe(true);
  });
});
