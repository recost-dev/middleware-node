# Interceptor Surgical Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two narrow correctness bugs in `src/core/interceptor.ts`: (a) `fetch(new Request(url, { body }))` reports `requestBytes: 0` because `estimateRequestBytes` only inspects `init.body` ([#12](https://github.com/recost-dev/middleware-node/issues/12)); (b) `http.request` overload edges — `options.path` is dropped when the first arg is a URL, and `opts.host` containing an embedded `:port` collides with a separate `opts.port` and triggers a silent URL parse failure ([#10](https://github.com/recost-dev/middleware-node/issues/10)). Single bundled PR.

**Architecture:** Three surgical edits inside `src/core/interceptor.ts`. (1) `estimateRequestBytes` becomes `async estimateRequestBytes(input, init?): Promise<number>` — when `init.body` is absent and `input` is a `Request` with a non-null body, it calls `input.clone()` and `await cloned.arrayBuffer()` to count bytes. Cloning tees the underlying body stream, so the original Request remains intact for the real outgoing HTTP request. The `patchedFetch` wrapper stores the returned promise and awaits it before recording telemetry on all three terminal paths (bodyless response, streaming response, fetch error). This is a deliberate contract change: stream-bodied Requests now report actual bytes (the issue's intent — "underreports request bytes for a common modern pattern"), at the cost of materializing the body in memory. (Note: `Request.headers.get("content-length")` is unreliable on Node's undici-backed `fetch` — undici sets the header on the wire but never on the `Request.headers` object — so the header-read path was empirically tested and rejected.) (2) `extractUrl(input)` gains an optional second parameter `pathOverride?: string`; when provided, it replaces `parsed.pathname` (with query stripping consistent with existing logic). The `http.request`/`https.request` wrapper computes that override from `options.path` when the *first arg* is a URL or URL-like string. (3) Inside the `RequestOptions` branch of `extractUrl`, an embedded port in `opts.host` is stripped before `opts.port` is appended. No public-API change. No new exports. No changes to the install/uninstall lifecycle or the double-count guard.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, tsup dual ESM + CJS build, Node.js ≥ 18.

---

## File Structure

- **Modify** `src/core/interceptor.ts`:
  - `extractUrl` signature gains optional `pathOverride?: string`.
  - `extractUrl`'s `RequestOptions` branch strips embedded port from `opts.host` before appending `opts.port`.
  - `estimateRequestBytes` signature changes from `(init?: RequestInit): number` to `async (input: string | URL | Request, init?: RequestInit): Promise<number>`. When `init.body` is absent and `input` is a Request with a non-null body, it clones the Request and awaits `cloned.arrayBuffer()`.
  - The `patchedFetch` wrapper stores `estimateRequestBytes(input, init)` as a promise, lets `_originalFetch(input, init)` run in parallel, then `await`s the bytes promise before capturing values for the event. The await happens at three points: success path (right after fetch returns the response), error path (inside the `catch (fetchError)` block, before building the error event).
  - The single `makeRequestWrapper` call site is updated to compute and pass `pathOverride` when applicable.
- **Modify** `tests/interceptor.test.ts`:
  - Add 4 new `it` blocks to the `describe("fetch interception")` block (lines 118–281) covering issue #12.
  - Add 3 new `it` blocks to the `describe("http.request interception")` block (lines 287+) covering issue #10a.
  - Add 2 new `it` blocks to the same block covering issue #10b.
  - All new tests reuse the existing `startServer` helper (lines 27–42), the existing `events: RawEvent[]` capture array, and the existing `install`/`uninstall` lifecycle from the surrounding `describe`. No new test infrastructure.
- **Modify** `docs/superpowers/roadmap-2026-05-13-issue-waves.md`:
  - Flip Wave 1 status from `in-progress` to `done`; add `**Merged PR:** https://github.com/recost-dev/middleware-node/pull/33`.
  - Flip Wave 2 status from `pending` to `done`; add `**Merged PR:** https://github.com/recost-dev/middleware-node/pull/34`.
  - Flip Wave 3 status from `pending` to `in-progress`; add a `**Plan:**` link to this file.
- **Create** `docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md` — this file.

**Test count delta:** baseline `230/230 vitest` (of which `7` are the `tests/dist.test.ts` smoke tests on the built bundle). Wave 3 adds `4 + 3 + 2 = 9` planned tests plus `1` follow-up regression test (already-consumed Request → `clone()` throws → records 0) prompted by code review on Task 2, all in `tests/interceptor.test.ts`. Final: `240/240 vitest`. `npm run test` runs vitest then re-runs `test:dist` (7 tests) as a separate post-build check.

`src/core/types.ts`, `src/index.ts`, `src/init.ts`, and all other source files are untouched. No `package.json`, `tsup.config.ts`, or `tsconfig.json` changes.

---

## Task 1: Set up Wave 3 worktree and commit the roadmap + plan

**Files:**
- Create worktree: `.claude/worktrees/wave-3-interceptor-fixes/`
- Modify: `docs/superpowers/roadmap-2026-05-13-issue-waves.md`
- Create: `docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md`

This task gets us off the obsolete Wave 2 worktree, onto a fresh branch off the latest `origin/main`, and lands the first commit (docs maintenance + plan doc) before any code edits. Mirrors the handoff's recommendation that the first commit be the leftover roadmap update.

- [ ] **Step 1: Verify we are not already inside the new worktree**

Run from any directory:

```bash
git -C /home/andresl/Projects/recost/middleware-node worktree list
```

Expected: the list does **not** already contain `.claude/worktrees/wave-3-interceptor-fixes`. If it does, the worktree was already created — skip step 2 and go to step 3.

- [ ] **Step 2: Create the Wave 3 worktree off the latest `origin/main`**

Run from `/home/andresl/Projects/recost/middleware-node` (the main repo root, NOT a worktree):

```bash
cd /home/andresl/Projects/recost/middleware-node
git fetch origin main
git worktree add -b feat/10-12-interceptor-fixes .claude/worktrees/wave-3-interceptor-fixes origin/main
cd .claude/worktrees/wave-3-interceptor-fixes
```

Expected output ends with: `Preparing worktree (new branch 'feat/10-12-interceptor-fixes')` and `HEAD is now at 51040ec Merge pull request #34 ...`.

All subsequent steps in this plan run from `.claude/worktrees/wave-3-interceptor-fixes/` unless stated otherwise.

- [ ] **Step 3: Copy this plan file into the new worktree**

From `.claude/worktrees/wave-3-interceptor-fixes/`, run:

```bash
cp ../wave-2-wire-format-cleanup/docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md
```

Expected: file exists at `docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md` inside the new worktree.

- [ ] **Step 4: Update the roadmap doc**

Open `docs/superpowers/roadmap-2026-05-13-issue-waves.md`.

Find the Wave 1 header block (currently around line 11–17):

```markdown
## Wave 1 — Transport terminal failure & cross-SDK parity

**Status:** in-progress (Sub-plan A spec/plan in this commit; Sub-plan B is a follow-up issue)
```

Replace with:

```markdown
## Wave 1 — Transport terminal failure & cross-SDK parity

**Status:** done

**Merged PR:** https://github.com/recost-dev/middleware-node/pull/33
```

Find the Wave 2 header block (currently around lines 41–43):

```markdown
## Wave 2 — Wire-format contract cleanup

**Status:** pending
```

Replace with:

```markdown
## Wave 2 — Wire-format contract cleanup

**Status:** done

**Merged PR:** https://github.com/recost-dev/middleware-node/pull/34
```

Find the Wave 3 header block (currently around lines 61–63):

```markdown
## Wave 3 — Interceptor surgical fixes

**Status:** pending
```

Replace with:

```markdown
## Wave 3 — Interceptor surgical fixes

**Status:** in-progress

**Plan:** `plans/2026-05-15-interceptor-surgical-fixes.md`
```

- [ ] **Step 5: Verify tests still pass on the fresh branch**

Run:

```bash
npm install
npm run lint
npm run test
```

Expected: lint clean. Vitest reports **230/230** (this total includes the 7 `dist.test.ts` smoke tests, which only pass after `npm run build` populates `dist/`). No code has changed yet — this is just a sanity check that the worktree is wired up correctly.

If `npm install` modifies `package-lock.json`, that is an environment artifact unrelated to this work — `git checkout -- package-lock.json` before staging.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/roadmap-2026-05-13-issue-waves.md docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md
git commit -m "docs: mark waves 1+2 done; add wave 3 surgical fixes plan (#10, #12)"
```

Verify: `git log --oneline -1` shows the new commit on top of `51040ec`.

---

## Task 2: Fix `requestBytes: 0` for `fetch(new Request(url, { body }))` (#12)

**Files:**
- Modify: `src/core/interceptor.ts:94-106` (signature + body of `estimateRequestBytes` — becomes async)
- Modify: `src/core/interceptor.ts:140-240` (`patchedFetch` — call site stores promise; await happens before each telemetry emit)
- Test: `tests/interceptor.test.ts` — add 4 `it` blocks inside the existing `describe("fetch interception")` (line 118)

TDD bundle: write all four failing tests first, run, confirm failure, implement, run, confirm pass, commit.

**Design note:** the first plan attempt used `Request.headers.get("content-length")` for sync recovery. Empirical testing on Node 26 confirmed undici does not populate `content-length` on `Request.headers` (only on the wire), so the sync path was rejected. The async clone+arrayBuffer approach below is the user-approved Option A: it deliberately changes the contract for stream-bodied Requests (was 0, now actual bytes — the issue's intent). Memory cost: the body is materialized in our clone tee branch, so peak memory for the request body roughly doubles. Acceptable for the typical small-body case the issue calls out.

- [ ] **Step 1: Add four failing tests inside `describe("fetch interception")`**

Open `tests/interceptor.test.ts`. Find the existing test `"handles Request object input"` (line 244–249). Immediately after its closing `});`, insert these four tests:

```typescript
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
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
npm run test -- --run tests/interceptor.test.ts -t "Request"
```

Expected: two of the four new tests fail.
- Test 1 (`"captures requestBytes for fetch(new Request(url, { body: string }))"`) fails with `expected 0 to be 11` — current implementation returns 0 because `init?.body` is undefined when body lives on the Request.
- Test 4 (`"Request with ReadableStream body → bytes measured from materialized clone"`) fails with `expected 0 to be 8` for the same reason.
- Tests 2 (`init.body overrides`) and 3 (`no body → 0`) pass coincidentally even before the fix — test 2 enters the `init?.body` branch, test 3 has no body so 0 is correct.

Do not proceed until you have seen at least the first test fail with `expected 0 to be 11` — that's the load-bearing one.

- [ ] **Step 3: Implement the fix in `estimateRequestBytes`**

Open `src/core/interceptor.ts`. Find `estimateRequestBytes` (lines 94–106):

```typescript
function estimateRequestBytes(init?: RequestInit): number {
  try {
    const body = init?.body;
    if (body == null) return 0;
    if (typeof body === "string") return Buffer.byteLength(body);
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    // ReadableStream, FormData, URLSearchParams, Blob — don't consume
    return 0;
  } catch {
    return 0;
  }
}
```

Replace with:

```typescript
async function estimateRequestBytes(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<number> {
  try {
    const body = init?.body;
    if (body != null) {
      if (typeof body === "string") return Buffer.byteLength(body);
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      // ReadableStream, FormData, URLSearchParams, Blob on init.body — don't
      // consume. (We can only safely consume a Request body via clone, below.)
      return 0;
    }
    // No init body — if input is a Request with a body, clone it and read the
    // cloned body. The clone tees the underlying body stream, so the original
    // Request remains intact for fetch to consume on the wire.
    if (
      typeof input === "object" &&
      input !== null &&
      !(input instanceof URL) &&
      typeof (input as Request).clone === "function" &&
      (input as Request).body != null
    ) {
      try {
        const cloned = (input as Request).clone();
        const buf = await cloned.arrayBuffer();
        return buf.byteLength;
      } catch {
        return 0;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Update `patchedFetch` to await the bytes promise**

In the same file, find `patchedFetch` (starts at line 140). The current body looks like this (with comments preserved):

```typescript
const patchedFetch: typeof globalThis.fetch = async (input, init?) => {
  let parsed: ParsedUrl | null = null;
  let method = "GET";
  let requestBytes = 0;

  try {
    parsed = extractUrl(input);
    if (typeof input === "object" && input !== null && "method" in input) {
      method = (input as Request).method ?? "GET";
    }
    if (init?.method) method = init.method;
    requestBytes = estimateRequestBytes(init);
  } catch {
    // Metadata extraction failed — proceed without instrumentation
  }

  if (parsed === null) {
    return _originalFetch!(input, init);
  }

  const startTime = performance.now();
  _inFetchWrapper = true;

  try {
    const response = await _originalFetch!(input, init);

    // Capture immutable values up-front; the body completion handler
    // may run long after this scope returns.
    const capturedParsed = parsed;
    const capturedMethod = method;
    const capturedRequestBytes = requestBytes;
```

Make exactly these three edits inside the wrapper:

**(a)** Replace `let requestBytes = 0;` (the third `let`) with:

```typescript
  let requestBytes = 0;
  let requestBytesPromise: Promise<number> | null = null;
```

**(b)** Replace `requestBytes = estimateRequestBytes(init);` with:

```typescript
    requestBytesPromise = estimateRequestBytes(input, init);
```

**(c)** Immediately after `const response = await _originalFetch!(input, init);` (currently at line 164), insert this block (BEFORE the existing `// Capture immutable values up-front` comment):

```typescript
    // Resolve async request-body measurement. The clone tee inside
    // estimateRequestBytes runs in parallel with the real wire request,
    // so by the time fetch resolves the response, this is typically already
    // settled. estimateRequestBytes never throws (all paths return 0 on error).
    if (requestBytesPromise !== null) {
      requestBytes = await requestBytesPromise;
    }

```

**(d)** Inside the `catch (fetchError)` block (currently at line 225), replace this section:

```typescript
  } catch (fetchError) {
    try {
      const latencyMs = performance.now() - startTime;
      _callback?.(buildEvent(parsed, method, 0, latencyMs, requestBytes, 0));
    } catch {
      // Telemetry error — swallow
    }

    throw fetchError;
  } finally {
```

with:

```typescript
  } catch (fetchError) {
    // Resolve async request-body measurement before recording the error event,
    // so a failed-with-body request still reports requestBytes accurately.
    if (requestBytesPromise !== null) {
      try {
        requestBytes = await requestBytesPromise;
      } catch {
        // estimateRequestBytes never throws; defensive only
      }
    }

    try {
      const latencyMs = performance.now() - startTime;
      _callback?.(buildEvent(parsed, method, 0, latencyMs, requestBytes, 0));
    } catch {
      // Telemetry error — swallow
    }

    throw fetchError;
  } finally {
```

After these four edits, `patchedFetch` still passes `input` and `init` to `_originalFetch` unchanged (the clone inside `estimateRequestBytes` works on its own tee branch).

- [ ] **Step 5: Run the four new tests and confirm they pass**

Run:

```bash
npm run test -- --run tests/interceptor.test.ts -t "Request"
```

Expected: all four new tests pass. (The pre-existing `"handles Request object input"` test, line 244, also still passes since it does not assert on `requestBytes`.)

- [ ] **Step 6: Run the full test suite and lint**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **234/234** (baseline 230 + 4 new; total still includes the 7 dist smoke tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/interceptor.ts tests/interceptor.test.ts
git commit -m "fix(interceptor): measure Request body via clone+arrayBuffer for fetch (#12)"
```

---

## Task 3: Fix `options.path` dropped when first arg is URL (#10a)

**Files:**
- Modify: `src/core/interceptor.ts:54-88` (extend `extractUrl` with `pathOverride`)
- Modify: `src/core/interceptor.ts:266` (compute and pass override inside `makeRequestWrapper`)
- Test: `tests/interceptor.test.ts` — add 3 `it` blocks inside `describe("http.request interception")` (line 287)

TDD bundle.

- [ ] **Step 1: Add three failing tests inside `describe("http.request interception")`**

Open `tests/interceptor.test.ts`. Find the existing test `"captures network error — statusCode 0, error true"` (around line 356). Immediately before that test's `it(...)` opener, insert these three tests:

```typescript
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
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
npm run test -- --run tests/interceptor.test.ts -t "path"
```

Expected: the first two new tests fail. The first asserts `path === "/options-wins"` but the current implementation records `/url-default` (the URL's pathname). The third (regression guard) passes already.

- [ ] **Step 3: Extend `extractUrl` with an optional `pathOverride`**

Open `src/core/interceptor.ts`. Find `extractUrl` (line 54):

```typescript
function extractUrl(input: string | URL | http.RequestOptions | { url: string; method?: string }): ParsedUrl | null {
  try {
    let raw: string;

    if (typeof input === "string") {
      raw = input;
    } else if (input instanceof URL) {
      raw = input.toString();
    } else if (typeof input === "object" && input !== null && "url" in input && typeof (input as Request).url === "string") {
      // Request object
      raw = (input as Request).url;
    } else if (typeof input === "object" && input !== null) {
      // http.RequestOptions: reconstruct from parts
      const opts = input as http.RequestOptions;
      const protocol = opts.protocol ?? "http:";
      const hostname = opts.hostname ?? opts.host ?? "localhost";
      const port = opts.port ? `:${opts.port}` : "";
      const rawPath = opts.path ?? "/";
      // Strip query string from path for privacy
      const pathname = rawPath.includes("?") ? rawPath.slice(0, rawPath.indexOf("?")) : rawPath;
      raw = `${protocol}//${hostname}${port}${pathname}`;
    } else {
      return null;
    }

    const parsed = new URL(raw);
    return {
      url: parsed.origin + parsed.pathname,
      host: parsed.hostname,
      path: parsed.pathname,
    };
  } catch {
    return null;
  }
}
```

Replace with:

```typescript
function extractUrl(
  input: string | URL | http.RequestOptions | { url: string; method?: string },
  pathOverride?: string,
): ParsedUrl | null {
  try {
    let raw: string;

    if (typeof input === "string") {
      raw = input;
    } else if (input instanceof URL) {
      raw = input.toString();
    } else if (typeof input === "object" && input !== null && "url" in input && typeof (input as Request).url === "string") {
      // Request object
      raw = (input as Request).url;
    } else if (typeof input === "object" && input !== null) {
      // http.RequestOptions: reconstruct from parts
      const opts = input as http.RequestOptions;
      const protocol = opts.protocol ?? "http:";
      const hostRaw = opts.hostname ?? opts.host ?? "localhost";
      // Defensive: strip any port embedded in `opts.host` so it does not
      // collide with a separately-specified `opts.port` (e.g. "h:8080" + 8080
      // would otherwise produce an unparseable "h:8080:8080").
      const hostname = hostRaw.includes(":") ? hostRaw.slice(0, hostRaw.indexOf(":")) : hostRaw;
      const port = opts.port ? `:${opts.port}` : "";
      const rawPath = opts.path ?? "/";
      // Strip query string from path for privacy
      const pathname = rawPath.includes("?") ? rawPath.slice(0, rawPath.indexOf("?")) : rawPath;
      raw = `${protocol}//${hostname}${port}${pathname}`;
    } else {
      return null;
    }

    const parsed = new URL(raw);

    // Apply the path override last, after URL parsing. The override beats the
    // URL's own pathname — this is the http.request(URL, { path }) case where
    // the second-arg options.path is the caller's actual intent.
    if (pathOverride != null && pathOverride !== "") {
      const overrideStripped = pathOverride.includes("?")
        ? pathOverride.slice(0, pathOverride.indexOf("?"))
        : pathOverride;
      return {
        url: parsed.origin + overrideStripped,
        host: parsed.hostname,
        path: overrideStripped,
      };
    }

    return {
      url: parsed.origin + parsed.pathname,
      host: parsed.hostname,
      path: parsed.pathname,
    };
  } catch {
    return null;
  }
}
```

Note: this single edit ALSO contains the embedded-port strip for `opts.host` (the 10b fix). Both edits land in this one file rewrite to keep the function coherent. The 10b regression tests are added in Task 4, but the implementation is here.

- [ ] **Step 4: Compute and pass `pathOverride` from the http.request wrapper**

In the same file, find lines 261–293 inside `makeRequestWrapper`:

```typescript
    let parsed: ParsedUrl | null = null;
    let method = "GET";
    let requestBytes = 0;

    try {
      parsed = extractUrl(urlOrOptions);

      if (typeof urlOrOptions === "object" && !(urlOrOptions instanceof URL) && urlOrOptions.method) {
        method = urlOrOptions.method;
      }
      if (
        typeof optionsOrCallback === "object" &&
        optionsOrCallback !== null &&
        (optionsOrCallback as http.RequestOptions).method
      ) {
        method = (optionsOrCallback as http.RequestOptions).method!;
      }

      const opts = typeof urlOrOptions === "object" && !(urlOrOptions instanceof URL)
        ? urlOrOptions as http.RequestOptions
        : typeof optionsOrCallback === "object" && optionsOrCallback !== null
          ? optionsOrCallback as http.RequestOptions
          : null;

      if (opts?.headers && typeof opts.headers === "object") {
        const cl = (opts.headers as Record<string, string | string[]>)["content-length"];
        if (cl != null) {
          requestBytes = parseInt(Array.isArray(cl) ? cl[0]! : cl, 10) || 0;
        }
      }
    } catch {
      // Metadata extraction failed — proceed without instrumentation
    }
```

Replace with:

```typescript
    let parsed: ParsedUrl | null = null;
    let method = "GET";
    let requestBytes = 0;

    try {
      // When the first arg is a URL or URL-like string, an options.path on the
      // second arg overrides the URL's pathname (matching Node's actual request
      // routing). When the first arg is RequestOptions itself, the path inside
      // it is already consumed by extractUrl's RequestOptions branch — no
      // override needed (and applying one would be a no-op anyway).
      const firstArgIsUrlish =
        typeof urlOrOptions === "string" || urlOrOptions instanceof URL;
      const secondArgPath =
        typeof optionsOrCallback === "object" &&
        optionsOrCallback !== null &&
        typeof (optionsOrCallback as http.RequestOptions).path === "string"
          ? (optionsOrCallback as http.RequestOptions).path
          : undefined;
      const pathOverride = firstArgIsUrlish ? secondArgPath : undefined;

      parsed = extractUrl(urlOrOptions, pathOverride);

      if (typeof urlOrOptions === "object" && !(urlOrOptions instanceof URL) && urlOrOptions.method) {
        method = urlOrOptions.method;
      }
      if (
        typeof optionsOrCallback === "object" &&
        optionsOrCallback !== null &&
        (optionsOrCallback as http.RequestOptions).method
      ) {
        method = (optionsOrCallback as http.RequestOptions).method!;
      }

      const opts = typeof urlOrOptions === "object" && !(urlOrOptions instanceof URL)
        ? urlOrOptions as http.RequestOptions
        : typeof optionsOrCallback === "object" && optionsOrCallback !== null
          ? optionsOrCallback as http.RequestOptions
          : null;

      if (opts?.headers && typeof opts.headers === "object") {
        const cl = (opts.headers as Record<string, string | string[]>)["content-length"];
        if (cl != null) {
          requestBytes = parseInt(Array.isArray(cl) ? cl[0]! : cl, 10) || 0;
        }
      }
    } catch {
      // Metadata extraction failed — proceed without instrumentation
    }
```

- [ ] **Step 5: Run the three new tests and confirm they pass**

Run:

```bash
npm run test -- --run tests/interceptor.test.ts -t "path"
```

Expected: all three new tests pass.

- [ ] **Step 6: Run the full test suite and lint**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **237/237** (baseline 230 + 4 from Task 2 + 3 from Task 3; total still includes the 7 dist smoke tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/interceptor.ts tests/interceptor.test.ts
git commit -m "fix(interceptor): honor options.path when first arg is URL (#10)"
```

---

## Task 4: Add regression tests for `opts.host` embedded-port stripping (#10b)

**Files:**
- Modify: `tests/interceptor.test.ts` — add 2 `it` blocks inside `describe("http.request interception")` (line 287)

The implementation for 10b already shipped in Task 3 (the embedded-port strip is part of the `extractUrl` rewrite — see the "Note" in Task 3 Step 3). This task is the test-only commit that nails down the behavior and serves as a regression guard. The TDD discipline still applies: write the tests, run them, observe they pass (since the implementation already exists), commit.

Why split into its own commit: it keeps the git history honest about which fix changed which behavior, and it lets future archaeology bisect cleanly per issue.

- [ ] **Step 1: Add two regression-guard tests inside `describe("http.request interception")`**

Open `tests/interceptor.test.ts`. Find the third test added in Task 3, `"RequestOptions-only path is unaffected (regression guard, no override)"`. Immediately after its closing `});`, insert these two tests:

```typescript
  it("strips embedded port from opts.host when opts.port is also set (#10b)", async () => {
    const port = parseInt(server.baseUrl.split(":")[2]!, 10);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        // Pathological-but-valid: caller put the port in `host` AND set `port`.
        // Pre-fix this raised "Invalid URL" inside extractUrl, silently
        // skipping instrumentation.
        { host: `127.0.0.1:${port}`, port, path: "/host-with-port" },
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
```

- [ ] **Step 2: Run the new tests and confirm they pass**

Run:

```bash
npm run test -- --run tests/interceptor.test.ts -t "10b"
```

Expected: both new tests pass. Implementation already exists from Task 3.

- [ ] **Step 3: Run the full test suite and lint**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **239/239** (baseline 230 + 4 + 3 + 2; total still includes the 7 dist smoke tests).

- [ ] **Step 4: Commit**

```bash
git add tests/interceptor.test.ts
git commit -m "test(interceptor): strip embedded port from opts.host (#10)"
```

---

## Task 5: Final verification and open the PR

**Files:** none modified. Verification + PR creation only.

- [ ] **Step 1: Run the full pre-flight gate**

Run:

```bash
npm run lint && npm run build && npm run test
```

Expected: lint clean, build emits both `dist/esm/` and `dist/cjs/`, vitest reports **239/239** (total includes the 7 `dist.test.ts` smoke tests; `npm run test` additionally re-runs those 7 as `test:dist` after build).

- [ ] **Step 2: Verify the branch state**

Run:

```bash
git log --oneline origin/main..HEAD
```

Expected output (six commits, newest first — including the plan revision and the Task 2 review fix-up that landed during execution):

```
<sha> test(interceptor): strip embedded port from opts.host (#10)
<sha> fix(interceptor): honor options.path when first arg is URL (#10)
<sha> fix(interceptor): skip body measurement on parse failure; expand #12 comments+tests
<sha> fix(interceptor): measure Request body via clone+arrayBuffer for fetch (#12)
<sha> docs(plans): revise #12 approach to async clone+arrayBuffer
<sha> docs: mark waves 1+2 done; add wave 3 surgical fixes plan (#10, #12)
```

Run:

```bash
git status
```

Expected: `nothing to commit, working tree clean` (or only the `package-lock.json` artifact, which should NOT be committed).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/10-12-interceptor-fixes
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create \
  --base main \
  --title "fix(interceptor): surgical fixes for Request body bytes + http.request overload edges (#10, #12)" \
  --body "$(cat <<'EOF'
## Summary

Wave 3 — two narrow correctness bugs in `src/core/interceptor.ts`, plus the leftover roadmap docs maintenance from Wave 2.

- **#12** — `fetch(new Request(url, { body }))` reported `requestBytes: 0` because `estimateRequestBytes` only inspected `init.body`. (`Request.headers.get("content-length")` is unreliable on Node's undici fetch — undici sets the header on the wire but not on `Request.headers`.) Fix: `estimateRequestBytes` becomes async, clones the Request, and reads `cloned.arrayBuffer()` for the byte count. The clone tees the body stream, so the original Request still feeds the actual outgoing HTTP request. Deliberate contract change: stream-bodied Requests now report actual bytes (the issue's intent) at the cost of materializing the body in memory (~2× peak for the body).
- **#10a** — `http.request(URL, { path })` silently dropped `options.path`. Fix: `extractUrl` gains an optional `pathOverride`; the wrapper computes it from the second-arg `options.path` when the first arg is a URL/string.
- **#10b** — `opts.host` containing an embedded `:port` plus a separate `opts.port` produced an unparseable URL (`host:port:port`), silently skipping instrumentation. Fix: strip any embedded port from `opts.host` before appending `opts.port`.

No public API changes. No new exports. No changes to the install/uninstall lifecycle or the double-count guard.

## Roadmap

First commit also marks Waves 1 + 2 as done (links to merged PRs #33 and #34) and flips Wave 3 to in-progress — leftover docs maintenance bundled into this PR.

## Test plan

- [x] `npm run lint` clean
- [x] `npm run build` emits ESM + CJS
- [x] `npm run test` — **240/240 vitest** (baseline 230 + 10 new; includes the 7 dist smoke tests; `test:dist` re-runs those 7 separately after build)
  - 4 tests for #12 main behavior (string body / init.body wins / no body / stream body — bytes from materialized clone)
  - 1 follow-up test for #12 (already-consumed Request → `clone()` throws → records 0)
  - 3 tests for #10a (URL + options.path / query stripping / RequestOptions-only regression)
  - 2 tests for #10b (host:port + port / hostname + port regression)

## Plan

See `docs/superpowers/plans/2026-05-15-interceptor-surgical-fixes.md`.

Closes #10, closes #12.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. Record it.

- [ ] **Step 5: Hand off**

Update `docs/superpowers/roadmap-2026-05-13-issue-waves.md` (in a follow-up session, once this PR is merged) to flip Wave 3 from `in-progress` to `done` and add the merged PR link. That update lands on the Wave 4 branch — same handoff convention Wave 3 used for Wave 2's leftover.

---

## Self-Review Notes

**Spec coverage:**
- #12 (Request body bytes) → Task 2. ✓
- #10a (options.path override) → Task 3. ✓
- #10b (embedded port strip) → implementation in Task 3, tests in Task 4. ✓
- Roadmap docs maintenance → Task 1. ✓
- Final PR → Task 5. ✓

**Placeholder scan:** none. Every code block is concrete. Every command is exact. Every expected output is specified.

**Type consistency:**
- `estimateRequestBytes` signature change: caller at line 151 updated. No other callers.
- `extractUrl` signature change: only two callers — the fetch wrapper (line 146, passes 1 arg, unchanged) and the http wrapper (line 266, now passes 2 args). Both updated.
- `ParsedUrl` interface (line 43–47) unchanged.
- `RawEvent` shape unchanged.

**Bundling note:** Task 3's implementation rewrite of `extractUrl` contains the 10b fix as well as the 10a fix. Task 4 is a test-only commit that exercises the 10b path. This split keeps git archaeology per-issue clean (a `git log --grep="#10"` shows two commits, each isolated to its sub-bug's behavior) without rewriting the function twice.
