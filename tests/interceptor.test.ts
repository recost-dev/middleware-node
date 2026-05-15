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
    await res.text();
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
    const res = await fetch(server.baseUrl + "/", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    await res.text();
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
    await res.text();
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
    await res.text();
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

    const res = await fetch(server.baseUrl + "/path?secret=abc&key=123");
    await res.text();
    // Event URL should not contain query params
    expect(events[0]!.url).not.toContain("?");
    expect(events[0]!.url).not.toContain("secret");
    // But the actual request received the full URL
    expect(receivedUrl).toContain("secret");
    expect(receivedUrl).toContain("key=123");
  });

  it("handles URL object input", async () => {
    const res = await fetch(new URL(server.baseUrl + "/from-url"));
    await res.text();
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/from-url");
  });

  it("handles Request object input", async () => {
    const res = await fetch(new Request(server.baseUrl + "/from-request"));
    await res.text();
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/from-request");
  });

  it("captures requestBytes for fetch(new Request(url, { body: string }))", async () => {
    const body = "hello world";
    const res = await fetch(
      new Request(server.baseUrl + "/req-body", { method: "POST", body }),
    );
    await res.text();
    expect(events).toHaveLength(1);
    expect(events[0]!.method).toBe("POST");
    expect(events[0]!.requestBytes).toBe(Buffer.byteLength(body));
  });

  it("init.body overrides Request.body for requestBytes (spec compliance)", async () => {
    const initBody = "init-wins";
    const res = await fetch(
      new Request(server.baseUrl + "/override", { method: "POST", body: "request-body" }),
      { body: initBody, method: "POST" },
    );
    await res.text();
    expect(events).toHaveLength(1);
    expect(events[0]!.requestBytes).toBe(Buffer.byteLength(initBody));
  });

  it("Request with no body and no content-length → requestBytes is 0", async () => {
    const res = await fetch(new Request(server.baseUrl + "/no-body", { method: "GET" }));
    await res.text();
    expect(events).toHaveLength(1);
    expect(events[0]!.requestBytes).toBe(0);
  });

  it("Request with ReadableStream body → bytes measured from materialized clone (#12)", async () => {
    const payload = "streamed";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    // `duplex: "half"` is required by undici for streaming request bodies.
    // Cast keeps this test compatible with older `@types/node` that omit duplex.
    const req = new Request(server.baseUrl + "/stream", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex?: string });
    const res = await fetch(req);
    await res.text();
    expect(events).toHaveLength(1);
    expect(events[0]!.requestBytes).toBe(Buffer.byteLength(payload));
  });

  it("Request whose body was already consumed → clone() throws, requestBytes is 0 (#12)", async () => {
    const req = new Request(server.baseUrl + "/used", {
      method: "POST",
      body: "already-read",
    });
    // Consume the body before passing the Request to fetch; clone() now throws
    // a TypeError. estimateRequestBytes catches it and reports 0 rather than
    // propagating the error or breaking the fetch.
    await req.text();
    // The actual fetch call will also fail (body already used), so we wrap it
    // — we just need to verify the interceptor doesn't crash and records 0.
    let fetchError: unknown = null;
    try {
      await fetch(req);
    } catch (e) {
      fetchError = e;
    }
    expect(fetchError).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]!.requestBytes).toBe(0);
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
    const res = await fetch(server.baseUrl + "/");
    await res.text();
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

  it("honors options.path when first arg is a URL (path override)", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        new URL(`http://127.0.0.1:${port}/url-default`),
        { path: "/options-wins", method: "POST" },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.path).toBe("/options-wins");
    expect(e.url.endsWith("/options-wins")).toBe(true);
    expect(e.method).toBe("POST");
  });

  it("strips query from options.path override", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/url-default`,
        { path: "/options-path?secret=x&token=y" },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/options-path");
    expect(events[0]!.url).not.toContain("?");
    expect(events[0]!.url).not.toContain("secret");
  });

  it("RequestOptions-only path is unaffected (regression guard, no override)", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/options-only" },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe("/options-only");
  });

  it("strips embedded port from opts.host when opts.port is also set (#10b)", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    await new Promise<void>((resolve) => {
      const req = http.request(
        // Pathological-but-valid: caller put the port in `host` AND set `port`.
        // Pre-fix this raised "Invalid URL" inside extractUrl, silently
        // skipping instrumentation. Node itself treats `host` literally for DNS
        // (so the request fails to resolve), but our instrumentation must still
        // capture the event via the error path with a correctly-parsed host.
        { host: `127.0.0.1:${port}`, port, path: "/host-with-port" },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", () => resolve());
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.host).toBe("127.0.0.1");
    expect(events[0]!.path).toBe("/host-with-port");
  });

  it("opts.hostname + opts.port works unchanged (regression guard for #10b)", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/hostname-port" },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.host).toBe("127.0.0.1");
    expect(events[0]!.path).toBe("/hostname-port");
  });

  it("strips embedded port from bracketed IPv6 opts.host (#10b IPv6 follow-up)", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    // Bracketed IPv6 form: opts.host = "[::1]:PORT" + opts.port = PORT.
    // Pre-fix: hostRaw.indexOf(":") was 1 (inside [::1]) → hostname truncated
    // to "[" → URL build failed and silently dropped the event.
    // Post-fix: bracket-aware strip preserves "[::1]" → URL builds correctly
    // as "http://[::1]:PORT/path".
    // Note: Node treats opts.host as a literal hostname for DNS, so the actual
    // request errors out — but the interceptor captures via the error-path
    // callback. WHATWG `URL.hostname` retains brackets for IPv6 literals, so
    // the captured event.host is `[::1]` (not `::1`). DNS failure on a literal
    // bracketed-IPv6 hostname is slow (~3-4s on Linux), so this test gets an
    // extended timeout.
    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: `[::1]:${port}`, port, path: "/v6-bracketed" },
        (res) => {
          res.resume();
          res.once("close", resolve);
        },
      );
      req.once("error", () => resolve());
      req.end();
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.host).toBe("[::1]");
    expect(events[0]!.path).toBe("/v6-bracketed");
  }, 10000);

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
    const res = await fetch(server.baseUrl + "/");
    await res.text();
    // fetch internally delegates to http — _inFetchWrapper guard prevents double-count
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Re-entrancy guard (_inFetchWrapper) must not leak across calls.
//
// Regression: if the fetch wrapper ever failed to reset _inFetchWrapper
// (e.g. a throw between set-true and reset), every subsequent http.request
// would be silently dropped for the rest of the process. These tests verify
// the guard is reset in both success and throw paths, and that a throwing
// user callback does not strand the guard in the "true" state.
// ---------------------------------------------------------------------------

describe("fetch re-entrancy guard", () => {
  let server: TestServer;
  const events: RawEvent[] = [];
  const baseHandler = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200);
    res.end("ok");
  };

  beforeEach(async () => {
    events.length = 0;
    server = await startServer(baseHandler);
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("subsequent http.request is still captured after a successful fetch (guard reset on happy path)", async () => {
    install((e) => events.push(e));

    await fetch(server.baseUrl + "/fetch-ok");
    await httpGet(server.baseUrl + "/http-after-success");

    const httpEvent = events.find((e) => e.path === "/http-after-success");
    expect(httpEvent).toBeDefined();
    expect(httpEvent!.method).toBe("GET");
  });

  it("subsequent http.request is still captured after a fetch that throws (guard reset on error path)", async () => {
    install((e) => events.push(e));

    await expect(fetch("http://127.0.0.1:1/unreachable")).rejects.toThrow();
    await httpGet(server.baseUrl + "/http-after-throw");

    const httpEvent = events.find((e) => e.path === "/http-after-throw");
    expect(httpEvent).toBeDefined();
  });

  it("throwing user callback during fetch does not leave re-entrancy guard stuck — later http.request still intercepted", async () => {
    let fetchCallbackFired = false;
    install((e) => {
      if (e.path === "/fetch-throws") {
        fetchCallbackFired = true;
        throw new Error("user callback exploded");
      }
      events.push(e);
    });

    // Fetch whose callback throws. The wrapper swallows callback errors,
    // but the guard must still end up reset regardless.
    const res = await fetch(server.baseUrl + "/fetch-throws");
    await res.text();
    expect(fetchCallbackFired).toBe(true);

    // If the guard had leaked (stayed true), this http.request would be
    // silently dropped. It must be captured normally.
    await httpGet(server.baseUrl + "/http-after-throwing-cb");
    const httpEvent = events.find((e) => e.path === "/http-after-throwing-cb");
    expect(httpEvent).toBeDefined();
  });

  it("many consecutive fetches with throwing callback do not degrade http.request capture", async () => {
    install((e) => {
      if (e.path.startsWith("/fetch-")) {
        throw new Error("always throws on fetch");
      }
      events.push(e);
    });

    for (let i = 0; i < 5; i++) {
      await fetch(server.baseUrl + `/fetch-${i}`);
    }

    await httpGet(server.baseUrl + "/http-final");
    expect(events.filter((e) => e.path === "/http-final")).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// End-of-body latency unification (audit issue #5)
// ---------------------------------------------------------------------------

describe("fetch end-of-body latency", () => {
  let server: TestServer;
  const events: RawEvent[] = [];
  const BODY_DELAY_MS = 250;

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-chunk");
      setTimeout(() => {
        res.write("second-chunk");
        res.end();
      }, BODY_DELAY_MS);
    });
    install((e) => events.push(e));
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("records end-of-body latency for a streamed fetch response, not time-to-first-byte", async () => {
    const res = await fetch(server.baseUrl + "/stream");
    const text = await res.text();
    expect(text).toBe("first-chunksecond-chunk");

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.latencyMs).toBeGreaterThanOrEqual(BODY_DELAY_MS - 50);
    expect(e.statusCode).toBe(200);
  });

  it("records non-zero responseBytes for a chunked fetch response with no content-length header", async () => {
    const res = await fetch(server.baseUrl + "/stream");
    const text = await res.text();
    expect(text).toBe("first-chunksecond-chunk");

    expect(events).toHaveLength(1);
    expect(events[0]!.responseBytes).toBe(Buffer.byteLength("first-chunksecond-chunk"));
  });

  it("records end-of-body latency even when caller does not read the body", async () => {
    const res = await fetch(server.baseUrl + "/stream");
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, BODY_DELAY_MS + 100));

    expect(events).toHaveLength(1);
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(BODY_DELAY_MS - 50);
  });
});

describe("http.request end-of-body latency and chunked bytes", () => {
  let server: TestServer;
  const events: RawEvent[] = [];
  const BODY_DELAY_MS = 250;

  beforeEach(async () => {
    events.length = 0;
    server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("alpha");
      setTimeout(() => {
        res.write("omega");
        res.end();
      }, BODY_DELAY_MS);
    });
    install((e) => events.push(e));
  });

  afterEach(async () => {
    uninstall();
    await server.close();
  });

  it("records end-of-body latency for a streamed http.get response", async () => {
    const { statusCode, body } = await httpGet(server.baseUrl + "/stream");
    expect(statusCode).toBe(200);
    expect(body).toBe("alphaomega");

    expect(events).toHaveLength(1);
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(BODY_DELAY_MS - 50);
  });

  it("records non-zero responseBytes from chunks when content-length is absent", async () => {
    const { body } = await httpGet(server.baseUrl + "/stream");
    expect(body).toBe("alphaomega");

    expect(events).toHaveLength(1);
    expect(events[0]!.responseBytes).toBe(Buffer.byteLength("alphaomega"));
  });
});
