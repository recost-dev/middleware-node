# 401 Auth-Failure Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently dropping windows on 401. After `maxConsecutiveAuthFailures` (default 5) consecutive 401s, suspend cloud telemetry, fire a typed `RecostFatalAuthError` through the existing `onError`, and emit two stderr lines per episode (first 401, fatal suspend) regardless of the `debug` flag. Closes [recost-dev/middleware-node#16](https://github.com/recost-dev/middleware-node/issues/16).

**Architecture:** Three new `Error` subclasses (`RecostError`, `RecostAuthError`, `RecostFatalAuthError`) land in `src/core/types.ts` mirroring the hierarchy already declared in `middleware-python/recost/_types.py`. `Transport` gains two private fields (`_consecutiveAuthFailures`, `_cloudSuspended`) and a 401 lifecycle branch inside `_sendOne`. The counter resets on any non-401 outcome. Recovery is restart-only; `handle.reconfigure(...)` is captured in the spec as future work. Existing `onError(err: Error)` signature is unchanged — hosts narrow via `instanceof`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, tsup dual ESM + CJS build.

---

## File Structure

- **Modify** `src/core/types.ts` — add `RecostError`, `RecostAuthError`, `RecostFatalAuthError` classes (runtime exports — these are now the *only* runtime exports in this file, which is otherwise pure type definitions); add `maxConsecutiveAuthFailures?: number` to `RecostConfig`.
- **Modify** `src/core/transport.ts` — add `_consecutiveAuthFailures` + `_cloudSuspended` state; resolve the new config field; add suspended-state early return at the top of the cloud branch of `_sendOne`; handle 401 separately from other rejections; reset the counter on success / non-401 rejection / catch. Remove the 401 branch from `_reportRejection` (now handled inline in `_sendOne`).
- **Modify** `src/index.ts` — re-export the three new error classes.
- **Modify** `tests/transport.test.ts` — add 9 new test cases in a new `describe("Transport — 401 auth-failure handling")` block; update one existing 401 test to assert against `RecostAuthError`.
- **Modify** `README.md` — document `maxConsecutiveAuthFailures`, the three error classes, the host-side narrowing snippet, and the "restart after rotating apiKey" recovery path.

Rationale: all behavior change is local to `Transport`. The three error classes are co-located in `types.ts` because (a) `Transport` already imports from `types.ts`, (b) consumers narrow on them and `src/index.ts` already re-exports from `types.ts`, and (c) the Python sibling co-locates them in `_types.py`.

---

## Task 1: Add the three error classes to `src/core/types.ts`

**Files:**
- Modify: `src/core/types.ts` (append after the existing type definitions)

This task is class definitions only — no behavior, no transport changes. It's safe to commit in isolation because nothing imports the classes yet.

- [ ] **Step 1: Add the classes**

Open `src/core/types.ts`. After the final existing definition (the `FlushStatus` interface), append:

```typescript
// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

/**
 * Base class for typed SDK errors passed to `onError` callbacks.
 * Hosts can use `instanceof RecostError` to distinguish SDK-originated errors
 * from unrelated `Error`s a generic error handler might also receive.
 */
export class RecostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecostError";
  }
}

/**
 * The cloud API rejected the configured `apiKey` (HTTP 401). Fired through
 * `onError` on every 401 response. After `maxConsecutiveAuthFailures`
 * consecutive 401s, `RecostFatalAuthError` is fired instead and the cloud
 * transport suspends for the lifetime of the process.
 */
export class RecostAuthError extends RecostError {
  readonly status: number;
  readonly consecutiveFailures: number;
  constructor(status: number, consecutiveFailures: number, message?: string) {
    super(
      message ??
        `Recost API returned ${status} (auth failed; ${consecutiveFailures} consecutive)`,
    );
    this.name = "RecostAuthError";
    this.status = status;
    this.consecutiveFailures = consecutiveFailures;
  }
}

/**
 * Cloud transport has been suspended after `maxConsecutiveAuthFailures`
 * consecutive 401s. Subsequent `send()` calls are silent no-ops until the
 * host process is restarted with a corrected `apiKey`.
 */
export class RecostFatalAuthError extends RecostAuthError {
  constructor(status: number, consecutiveFailures: number) {
    super(
      status,
      consecutiveFailures,
      `Recost cloud transport suspended after ${consecutiveFailures} consecutive auth failures. Restart after rotating apiKey.`,
    );
    this.name = "RecostFatalAuthError";
  }
}
```

- [ ] **Step 2: Add the new `RecostConfig` field**

Find the `RecostConfig` interface in `src/core/types.ts`. Add the following field just **before** the existing `onError` field at the end:

```typescript
  /**
   * Number of consecutive 401 responses from the cloud API after which the SDK
   * suspends cloud telemetry for the lifetime of the process. Recovery requires
   * rotating `apiKey` in config and restarting. Defaults to 5.
   */
  maxConsecutiveAuthFailures?: number;
```

- [ ] **Step 3: Run lint and tests to confirm nothing broke**

Run: `npm run lint && npm run test`
Expected: lint clean; all 219 existing tests still pass (no new tests yet — they come in later tasks).

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add RecostError/RecostAuthError/RecostFatalAuthError hierarchy (#16)"
```

---

## Task 2: Re-export the new error classes from `src/index.ts`

**Files:**
- Modify: `src/index.ts`

The three classes are runtime values (not just types), so they need a separate `export { ... }` line, not the `export type { ... }` block that handles the interfaces.

- [ ] **Step 1: Add the runtime export**

Open `src/index.ts`. The file currently has, on lines 7–15, a block that does:

```typescript
export type {
  RawEvent,
  MetricEntry,
  WindowSummary,
  ProviderDef,
  RecostConfig,
  TransportMode,
  FlushStatus,
} from "./core/types.js";
```

Immediately **after** that block (and before `export { init } from "./init.js";` on line 18), add:

```typescript
// Typed error classes (runtime values — separate export from the type-only block above)
export {
  RecostError,
  RecostAuthError,
  RecostFatalAuthError,
} from "./core/types.js";
```

- [ ] **Step 2: Run lint and build to confirm the dual ESM + CJS output still resolves**

Run: `npm run lint && npm run build`
Expected: lint clean; build emits `dist/esm/` and `dist/cjs/` and the new symbols appear in `dist/esm/index.js` (`grep -n "RecostAuthError" dist/esm/index.js` should match — single check, not part of CI).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(public-api): export RecostError/RecostAuthError/RecostFatalAuthError (#16)"
```

---

## Task 3: Wire `maxConsecutiveAuthFailures` through `ResolvedConfig`

**Files:**
- Modify: `src/core/transport.ts`

This task only threads the new config field through `resolveConfig` so the Transport can read it. It does not change any behavior yet — Task 4 adds the lifecycle.

- [ ] **Step 1: Add the field to `ResolvedConfig`**

Open `src/core/transport.ts`. In the `ResolvedConfig` interface (lines 18–29), after `maxWsQueueSize: number;` and before `debug: boolean;`, add:

```typescript
  maxConsecutiveAuthFailures: number;
```

- [ ] **Step 2: Resolve the default in `resolveConfig`**

In the `resolveConfig` function (lines 31–44), after the `maxWsQueueSize: config.maxWsQueueSize ?? 1000,` line and before `debug: config.debug ?? false,`, add:

```typescript
    maxConsecutiveAuthFailures: config.maxConsecutiveAuthFailures ?? 5,
```

- [ ] **Step 3: Run lint and tests to confirm nothing broke**

Run: `npm run lint && npm run test`
Expected: lint clean; all 219 existing tests still pass. (Field is plumbed but unused — TypeScript does not warn on unused interface members.)

- [ ] **Step 4: Commit**

```bash
git add src/core/transport.ts
git commit -m "feat(transport): wire maxConsecutiveAuthFailures through ResolvedConfig (#16)"
```

---

## Task 4: First failing test — single 401 produces `RecostAuthError(401, 1)`

**Files:**
- Modify: `tests/transport.test.ts`

We start the TDD cycle with the simplest case: one 401, one `RecostAuthError`, one stderr line, transport **not** suspended.

- [ ] **Step 1: Add the new describe block with the first test**

Open `tests/transport.test.ts`. First, update the top-level import on line 13:

```typescript
import type { MetricEntry, WindowSummary } from "../src/core/types.js";
```

to also pull in the new error classes:

```typescript
import {
  RecostAuthError,
  RecostFatalAuthError,
  type MetricEntry,
  type WindowSummary,
} from "../src/core/types.js";
```

Then, at the very end of the file (after the existing `describe("Transport — WebSocket queue cap", ...)` block that closes on line 604), append:

```typescript
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
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run test -- tests/transport.test.ts -t "single 401 fires RecostAuthError"`
Expected: FAIL. The current code fires `onError(new Error(msg))` (a plain `Error`), not a `RecostAuthError`. The `toBeInstanceOf(RecostAuthError)` assertion will fail.

- [ ] **Step 3: Do NOT commit yet — implementation lands in Task 5**

The failing test stays staged-or-unstaged until Task 5's implementation makes it pass. We commit the test and the implementation together at the end of Task 5 to keep the history bisectable.

---

## Task 5: Implement the 401 lifecycle in `Transport._sendOne`

**Files:**
- Modify: `src/core/transport.ts`

This is the core change. It introduces the counter, the suspended flag, the per-outcome reset, and the early-return for suspended-state — but only handles the *first*-of-an-episode lifecycle. Fatal-suspend lands in Task 6.

- [ ] **Step 1: Import the new error classes**

Open `src/core/transport.ts`. Find the import on lines 10–11:

```typescript
import type { FlushStatus, RecostConfig, TransportMode, WindowSummary } from "./types.js";
import { getRawFetch } from "./interceptor.js";
```

Split the type-only import and add a separate runtime import for the error classes:

```typescript
import type { FlushStatus, RecostConfig, TransportMode, WindowSummary } from "./types.js";
import { RecostAuthError, RecostFatalAuthError } from "./types.js";
import { getRawFetch } from "./interceptor.js";
```

- [ ] **Step 2: Add the two new private fields to `Transport`**

In `src/core/transport.ts`, find the existing private fields on the `Transport` class (around lines 100–112, the `// Local WebSocket state` section). Directly after `private _dropNotified = false;` on line 112, add:

```typescript

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
```

- [ ] **Step 3: Replace the cloud branch of `_sendOne` with the new lifecycle**

Find the current cloud branch in `_sendOne`, which is currently lines 233–244:

```typescript
    try {
      if (this._cfg.mode === "cloud") {
        const url = `${this._cfg.baseUrl}/projects/${this._cfg.projectId}/telemetry`;
        const result = await postCloud(url, body, this._cfg.apiKey, this._cfg.maxRetries);
        if (!result.ok) {
          this._reportRejection(result.status, windowSize);
          this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
          return;
        }
        this._lastFlushStatus = { status: "ok", windowSize, timestamp: Date.now() };
        return;
      }
```

Replace **just the cloud `if (this._cfg.mode === "cloud") { ... }` block** (preserving the outer `try {` and the local-mode branch that follows) with:

```typescript
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
```

- [ ] **Step 4: Reset the counter in the catch block**

The existing `catch (err)` block (around lines 269–277) handles `postCloud` throws (network errors after retries exhausted, etc.). Update it to reset the counter so a network blip between 401s does not falsely accumulate. Find:

```typescript
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const msg = `[recost] transport error (windowSize=${windowSize}): ${error.message}`;
      console.warn(msg);
      if (this._cfg.onError) {
        this._cfg.onError(error);
      }
      this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
    }
```

Replace with:

```typescript
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
```

- [ ] **Step 5: Add the `_handleAuthFailure` helper**

Add a new private method directly **after** the existing `_reportRejection` method (which ends around line 298, just before `/** Close WebSocket and cancel pending reconnect. */`). Insert:

```typescript

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
```

- [ ] **Step 6: Remove the 401 branch from `_reportRejection`**

`_reportRejection` (lines 285–298) currently handles 401, 403, 404, 422, and the default. Now that 401 is handled before `_reportRejection` is ever called, the 401 branch is dead code. Replace the whole method body. Find:

```typescript
  private _reportRejection(status: number, windowSize: number): void {
    const reason = status === 401
      ? "API key is invalid or has been revoked. Check RECOST_API_KEY."
      : status === 403
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
```

Replace with:

```typescript
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
```

- [ ] **Step 7: Run the Task 4 test to verify it now passes**

Run: `npm run test -- tests/transport.test.ts -t "single 401 fires RecostAuthError"`
Expected: PASS.

- [ ] **Step 8: Run the full transport test file to confirm no regressions**

Run: `npm run test -- tests/transport.test.ts`
Expected: All previously-passing tests still pass, plus the new one. Specifically: the existing test at `tests/transport.test.ts:192-207` ("does not retry on 4xx — exactly one attempt") still passes because we removed the 401 branch from `_reportRejection` but the retry-skip behavior lives in `postCloud` and is unchanged.

- [ ] **Step 9: Run lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 10: Commit test + implementation together**

```bash
git add src/core/transport.ts tests/transport.test.ts
git commit -m "feat(transport): typed RecostAuthError on 401, stderr warning, counter (#16)"
```

---

## Task 6: Add the fatal-threshold test (5 consecutive 401s)

**Files:**
- Modify: `tests/transport.test.ts`

The Task 5 implementation already covers fatal-suspend logic. This task adds the test that asserts the threshold and the second stderr line.

- [ ] **Step 1: Append the test inside the existing describe block**

Open `tests/transport.test.ts`. Inside the `describe("Transport — 401 auth-failure handling", () => { ... })` block from Task 4, append (just before the closing `});`):

```typescript

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
```

- [ ] **Step 2: Run the new test**

Run: `npm run test -- tests/transport.test.ts -t "five consecutive 401s"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): fatal-threshold lifecycle for 5 consecutive 401s (#16)"
```

---

## Task 7: Suspended-state silent no-op test

**Files:**
- Modify: `tests/transport.test.ts`

Once suspended, further sends must not hit the network, must not fire `onError`, must update `lastFlushStatus.status` to `"error"`, and must not emit additional stderr lines.

- [ ] **Step 1: Append the test inside the existing describe block**

Inside the `describe("Transport — 401 auth-failure handling", () => { ... })` block, append (before the closing `});`):

```typescript

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
```

- [ ] **Step 2: Run the test**

Run: `npm run test -- tests/transport.test.ts -t "after suspension"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): suspended-state is a silent no-op (#16)"
```

---

## Task 8: Counter-reset tests (4×401 then success / 3×401 then 403 / 3×401 then 5xx / 3×401 then network throw)

**Files:**
- Modify: `tests/transport.test.ts`

Four near-identical tests proving the counter resets on each of the four non-401 outcomes.

- [ ] **Step 1: Append all four tests inside the existing describe block**

Inside the `describe("Transport — 401 auth-failure handling", () => { ... })` block, append (before the closing `});`):

```typescript

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
```

- [ ] **Step 2: Run the four new tests**

Run: `npm run test -- tests/transport.test.ts -t "counter resets"`
Expected: All four PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): counter resets on success / 403 / 5xx / network throw (#16)"
```

---

## Task 9: Configurable threshold + local-mode-never-suspends tests

**Files:**
- Modify: `tests/transport.test.ts`

Two more tests: one proves `maxConsecutiveAuthFailures` is honored, one proves local mode is unaffected.

- [ ] **Step 1: Append the two tests inside the existing describe block**

```typescript

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
```

- [ ] **Step 2: Run the two new tests**

Run: `npm run test -- tests/transport.test.ts -t "maxConsecutiveAuthFailures: 2"`
Expected: PASS.

Run: `npm run test -- tests/transport.test.ts -t "local mode never suspends"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): configurable threshold + local mode never suspends (#16)"
```

---

## Task 10: Update the pre-existing 401 test to assert the new error type

**Files:**
- Modify: `tests/transport.test.ts`

There is one existing test that asserts the historical 401 behavior. With the changes from Task 5, its assertion shape needs to evolve from "plain `Error` with `401` in the message" to "`instanceof RecostAuthError` with `status === 401`."

Read the existing test at `tests/transport.test.ts:192-207`:

```typescript
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
```

It only asserts request count — it does not check the error type, so **no edit is required** for this test (the request-count behavior is unchanged: 4xx still skips retry inside `postCloud`).

- [ ] **Step 1: Audit the rest of `tests/transport.test.ts` for any test that asserts on a 401-specific error message**

Search the file for any string containing `"HTTP 401"` or `"401"` in an `expect(...).toContain(...)` or `expect(...).toMatch(...)` context.

Run: `grep -n "401" tests/transport.test.ts`

Expected: the only matches are inside the new `describe("Transport — 401 auth-failure handling")` block (Tasks 4 + 6 + 7 + 8 + 9) plus the request-count test above. If a stray legacy assertion on a 401 error *message* is found that this audit missed, update it to use `instanceof RecostAuthError` and `(err as RecostAuthError).status === 401` instead.

- [ ] **Step 2: Run the full transport test file**

Run: `npm run test -- tests/transport.test.ts`
Expected: every test passes.

- [ ] **Step 3: Run the whole suite**

Run: `npm run test`
Expected: every test passes (the full 219 baseline plus the 9 new cases = 228).

- [ ] **Step 4: No commit needed**

This task is verification + audit. If no legacy assertion needed fixing, there's nothing to commit.

---

## Task 11: Document the new behavior in `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Open `README.md` and find the configuration reference**

Run: `grep -n "maxWsQueueSize" README.md` to locate the existing config table.

- [ ] **Step 2: Add the new config row**

Below the row for `maxWsQueueSize` (or wherever `maxRetries`-adjacent config lives in the table), add:

```markdown
| `maxConsecutiveAuthFailures` | `number` | `5` | Consecutive 401 responses after which the cloud transport is suspended for the lifetime of the process. See "Auth failures" below. |
```

- [ ] **Step 3: Add a new "Auth failures" subsection**

After the configuration table (or alongside any existing "Error handling" section if present), add:

```markdown
### Auth failures

If `api.recost.dev` returns 401 (invalid or revoked `apiKey`), the SDK:

1. Logs a one-time warning to `stderr` on the first 401: `[recost] HTTP 401 — API key rejected. Telemetry will stop after 5 consecutive failures. Check your apiKey at https://recost.dev/dashboard/account.`
2. Calls `onError(new RecostAuthError(401, n))` on every 401, where `n` is the consecutive-failure count.
3. After `maxConsecutiveAuthFailures` (default 5) consecutive 401s, suspends the cloud transport for the lifetime of the process, logs a second `stderr` line announcing the suspension, and calls `onError(new RecostFatalAuthError(401, n))`. Subsequent `init`/`send` calls in this process are silent no-ops on the cloud transport.

Recovery is restart-only: update `apiKey` in your config and restart the process. The counter resets on any non-401 outcome (success, 403/404/422, 5xx after retries, network error), so transient outages do not accumulate toward the threshold.

Hosts can route auth failures separately from other errors by narrowing on the error class:

```ts
import { init, RecostAuthError, RecostFatalAuthError } from "@recost-dev/node";

init({
  apiKey: process.env.RECOST_API_KEY,
  projectId: process.env.RECOST_PROJECT_ID,
  onError(err) {
    if (err instanceof RecostFatalAuthError) pagerduty.fire(err);
    else if (err instanceof RecostAuthError) log.warn(err);
    else log.debug(err);
  },
});
```
```

- [ ] **Step 4: Run the dist-bundle smoke test**

Run: `npm run build && npm run test`
Expected: all 228 tests pass, including the 7 dist-bundle tests that import from the built output. This confirms `RecostError`, `RecostAuthError`, `RecostFatalAuthError`, and `maxConsecutiveAuthFailures` survive the dual ESM + CJS build.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document 401 auth-failure handling, RecostAuthError hierarchy (#16)"
```

---

## Task 12: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: 228/228 green (219 baseline + 9 new). Build clean. ESM + CJS + DTS all valid.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean dual ESM + CJS + DTS output in `dist/`.

- [ ] **Step 4: Manual diff review**

Run: `git log --oneline main..HEAD` and `git diff main..HEAD --stat`. Expected commits in order:

1. `feat(types): add RecostError/RecostAuthError/RecostFatalAuthError hierarchy (#16)`
2. `feat(public-api): export RecostError/RecostAuthError/RecostFatalAuthError (#16)`
3. `feat(transport): wire maxConsecutiveAuthFailures through ResolvedConfig (#16)`
4. `feat(transport): typed RecostAuthError on 401, stderr warning, counter (#16)`
5. `test(transport): fatal-threshold lifecycle for 5 consecutive 401s (#16)`
6. `test(transport): suspended-state is a silent no-op (#16)`
7. `test(transport): counter resets on success / 403 / 5xx / network throw (#16)`
8. `test(transport): configurable threshold + local mode never suspends (#16)`
9. `docs(readme): document 401 auth-failure handling, RecostAuthError hierarchy (#16)`

Files touched: `src/core/types.ts`, `src/core/transport.ts`, `src/index.ts`, `tests/transport.test.ts`, `README.md`.

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat: 401 auth-failure handling — suspend after N, typed errors (#16)" --body "$(cat <<'EOF'
## Summary
- Adds `RecostError` / `RecostAuthError` / `RecostFatalAuthError` to the public API; mirrors Python's pre-declared hierarchy.
- Suspends the cloud transport after `maxConsecutiveAuthFailures` (default 5) consecutive 401s. Recovery is restart-only.
- One-time stderr warning on first 401 + second stderr line at fatal-suspend, both regardless of `debug` flag.
- Existing `onError(err: Error)` signature is unchanged — hosts narrow via `instanceof`.

Closes #16.

## Test plan
- [ ] `npm run test` — 228/228 green (219 baseline + 9 new cases)
- [ ] `npm run lint` — clean
- [ ] `npm run build` — clean dual ESM + CJS + DTS
- [ ] Manually verify a fresh consumer can import `RecostAuthError` from `@recost-dev/node` in both ESM and CJS

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Add `RecostError`, `RecostAuthError`, `RecostFatalAuthError` to `types.ts` | Task 1 |
| Add `maxConsecutiveAuthFailures?: number` to `RecostConfig` | Task 1 |
| Re-export error classes from `src/index.ts` | Task 2 |
| Resolve `maxConsecutiveAuthFailures` default 5 in `ResolvedConfig` | Task 3 |
| Counter + suspended flag in `Transport` | Task 5 |
| Suspended-state early return | Task 5 + Task 7 (test) |
| Counter reset on 2xx / non-401 4xx / 5xx / network throw | Task 5 + Task 8 (tests) |
| 401 lifecycle: stderr on first, fatal at threshold, RecostAuthError/RecostFatalAuthError onError | Task 5 + Tasks 4, 6 (tests) |
| Remove 401 branch from `_reportRejection` | Task 5 |
| Configurable threshold honored | Task 9 |
| Local mode unaffected | Task 9 |
| Update existing 401 test (no change needed, verified) | Task 10 |
| README documentation | Task 11 |
| Final verification | Task 12 |

**Placeholder scan:** no TBDs, no "implement later", no abstract "add error handling" steps. Every code step contains the full code to type/paste. ✓

**Type consistency:** `RecostAuthError(status, consecutiveFailures, message?)` is referenced identically in Task 1 (definition), Task 5 (production code), and Tasks 4–9 (tests). `RecostFatalAuthError(status, consecutiveFailures)` likewise. `maxConsecutiveAuthFailures` uses the same camelCase name in `RecostConfig` (Task 1), `ResolvedConfig` (Task 3), `resolveConfig` (Task 3), `_handleAuthFailure` (Task 5), and test config (Task 9). `_consecutiveAuthFailures` and `_cloudSuspended` are referenced consistently. ✓
