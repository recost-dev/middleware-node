# WebSocket Terminal Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop spinning on doomed WebSocket reconnects in local mode. After `maxConsecutiveReconnectFailures` (default 20) consecutive failed reconnect attempts, pause the local transport, fire `onError(RecostLocalUnreachableError)` once, write one stderr line, and turn `send()` into a silent no-op until the host process is restarted with the VS Code extension running. Closes [recost-dev/middleware-node#22](https://github.com/recost-dev/middleware-node/issues/22).

**Architecture:** New `RecostLocalUnreachableError` class lands in `src/core/types.ts` next to the `RecostAuthError` hierarchy from PR #32. `Transport` gains one private field (`_localPaused`) and reuses the existing `_reconnectAttempts` counter (already incremented in `_scheduleReconnect`, reset to 0 on successful `ws.on("open")`). The threshold check goes at the top of `_scheduleReconnect`; on trip it calls a new `_handleLocalUnreachable` helper that latches the flag, emits stderr, fires `onError`, and clears the now-unreachable queue. The local branch of `_sendOne` and `_connectWs` get defensive paused-state early-returns. Recovery is restart-only; `handle.reconnect(...)` is captured in the spec as future work. Existing `onError(err: Error)` signature is unchanged — hosts narrow via `instanceof`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, tsup dual ESM + CJS build, `ws` library for WebSocket client (already a dependency).

---

## File Structure

- **Modify** `src/core/types.ts` — add `RecostLocalUnreachableError` class (extends existing `RecostError`); add `maxConsecutiveReconnectFailures?: number` field to `RecostConfig` immediately after the existing `maxConsecutiveAuthFailures?` field.
- **Modify** `src/core/transport.ts` — add `_localPaused: boolean` field to the local-state group; add `maxConsecutiveReconnectFailures: number` to `ResolvedConfig`; resolve default 20 in `resolveConfig`; add threshold check at top of `_scheduleReconnect`; add `_handleLocalUnreachable` helper directly after `_scheduleReconnect`; add paused-state early-return at the top of `_sendOne`'s local branch and at the top of `_connectWs`; import `RecostLocalUnreachableError`.
- **Modify** `src/index.ts` — re-export `RecostLocalUnreachableError` alongside the existing `RecostError` / `RecostAuthError` / `RecostFatalAuthError` runtime exports.
- **Modify** `tests/transport.test.ts` — add 7 new test cases in a new `describe("Transport — local-mode terminal failure handling")` block.
- **Modify** `README.md` — document `maxConsecutiveReconnectFailures`, the `RecostLocalUnreachableError` class, and the recovery path. Place the new content alongside the existing "Auth failures" subsection (added in PR #32) or under a new "Local-mode unavailability" subsection.

Rationale: all behavior change is local to `Transport`. The new error class is co-located in `types.ts` because (a) `Transport` already imports from `types.ts`, (b) consumers narrow on it and `src/index.ts` already re-exports from `types.ts`, and (c) it's a sibling to the `RecostAuthError` hierarchy added in #16.

---

## Task 1: Add `RecostLocalUnreachableError` and the new config field to `src/core/types.ts`

**Files:**
- Modify: `src/core/types.ts`

This task is class definition + field addition only — no behavior change. Safe to commit in isolation because nothing imports the class yet.

- [ ] **Step 1: Add the new error class**

Open `src/core/types.ts`. Find the existing `RecostFatalAuthError` class (added in PR #32). Append, immediately after `RecostFatalAuthError`'s closing `}`:

```typescript

/**
 * The local WebSocket transport (VS Code extension) was unreachable for
 * `maxConsecutiveReconnectFailures` consecutive reconnect attempts and has
 * been paused for the lifetime of the process. Recovery requires a process
 * restart with the extension running.
 */
export class RecostLocalUnreachableError extends RecostError {
  readonly consecutiveFailures: number;
  constructor(consecutiveFailures: number) {
    super(
      `Recost local WebSocket transport paused after ${consecutiveFailures} consecutive failed reconnects. ` +
      `Restart the process after starting the VS Code extension.`,
    );
    this.name = "RecostLocalUnreachableError";
    this.consecutiveFailures = consecutiveFailures;
  }
}
```

- [ ] **Step 2: Add the new `RecostConfig` field**

In the same file, find the `RecostConfig` interface. Find the field added in PR #32:

```typescript
  /**
   * Number of consecutive 401 responses from the cloud API after which the SDK
   * suspends cloud telemetry for the lifetime of the process. Recovery requires
   * rotating `apiKey` in config and restarting. Defaults to 5.
   */
  maxConsecutiveAuthFailures?: number;
```

Add immediately **after** that field (and before `onError`):

```typescript
  /**
   * Number of consecutive failed WebSocket reconnect attempts after which the
   * SDK pauses the local transport for the lifetime of the process. Recovery
   * requires a process restart with the VS Code extension running. Defaults to 20.
   */
  maxConsecutiveReconnectFailures?: number;
```

- [ ] **Step 3: Run lint and tests to confirm nothing broke**

Run: `npm run lint && npm run test`
Expected: lint clean; all 228 existing tests still pass (no new tests yet — they come in later tasks).

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add RecostLocalUnreachableError + maxConsecutiveReconnectFailures (#22)"
```

---

## Task 2: Re-export `RecostLocalUnreachableError` from `src/index.ts`

**Files:**
- Modify: `src/index.ts`

The class is a runtime value, so it goes in the existing runtime `export { ... }` block added in PR #32, not the `export type { ... }` block.

- [ ] **Step 1: Add the runtime export**

Open `src/index.ts`. Find the existing PR #32 runtime export block:

```typescript
// Typed error classes (runtime values — separate export from the type-only block above)
export {
  RecostError,
  RecostAuthError,
  RecostFatalAuthError,
} from "./core/types.js";
```

Add `RecostLocalUnreachableError` to the list (alphabetical-ish ordering puts it last; either order works):

```typescript
// Typed error classes (runtime values — separate export from the type-only block above)
export {
  RecostError,
  RecostAuthError,
  RecostFatalAuthError,
  RecostLocalUnreachableError,
} from "./core/types.js";
```

- [ ] **Step 2: Run lint and build to confirm the dual ESM + CJS output still resolves**

Run: `npm run lint && npm run build`
Expected: lint clean; build emits `dist/esm/`, `dist/cjs/`, `dist/types/`. Spot-check: `grep -n "RecostLocalUnreachableError" dist/esm/index.js` should match.

- [ ] **Step 3: Run the full test suite**

Run: `npm run test`
Expected: 228/228 green. The 7 dist-bundle tests in `tests/dist.test.ts` use a static `EXPECTED_VALUE_EXPORTS` list that does not include the new class; they assert each listed name is defined but tolerate extras, so they remain green. (Adding the new class to that list is left as a future tightening.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(public-api): export RecostLocalUnreachableError (#22)"
```

---

## Task 3: Wire `maxConsecutiveReconnectFailures` through `ResolvedConfig`

**Files:**
- Modify: `src/core/transport.ts`

Same plumbing pattern as PR #32's Task 3 for `maxConsecutiveAuthFailures`. Field is added but unused — Task 5 introduces the consumer.

- [ ] **Step 1: Add the field to `ResolvedConfig`**

Open `src/core/transport.ts`. Find the `ResolvedConfig` interface near the top. Find the line added in PR #32:

```typescript
  maxConsecutiveAuthFailures: number;
```

Add immediately after it:

```typescript
  maxConsecutiveReconnectFailures: number;
```

- [ ] **Step 2: Resolve the default in `resolveConfig`**

In the same file, find `resolveConfig`. Find the line added in PR #32:

```typescript
    maxConsecutiveAuthFailures: config.maxConsecutiveAuthFailures ?? 5,
```

Add immediately after it:

```typescript
    maxConsecutiveReconnectFailures: config.maxConsecutiveReconnectFailures ?? 20,
```

- [ ] **Step 3: Run lint and tests**

Run: `npm run lint && npm run test`
Expected: lint clean; 228/228 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/transport.ts
git commit -m "feat(transport): wire maxConsecutiveReconnectFailures through ResolvedConfig (#22)"
```

---

## Task 4: First failing test — single failed reconnect does NOT pause

**Files:**
- Modify: `tests/transport.test.ts`

TDD red phase. The simplest case: one failed connect attempt (initial connect to a port with nothing listening) → `_reconnectAttempts` increments via the existing reconnect machinery, but the threshold (default 20) is not hit → no `onError`, no stderr, transport stays unpaused.

This test asserts the *negative* before Task 5 introduces the positive lifecycle. It MUST pass after Task 5 lands too — the spec's lifecycle table row for "1st failed reconnect" requires this behavior.

- [ ] **Step 1: Update the imports**

Open `tests/transport.test.ts`. Find the import line that currently pulls in error classes (added in PR #32):

```typescript
import {
  RecostAuthError,
  RecostFatalAuthError,
  type MetricEntry,
  type WindowSummary,
} from "../src/core/types.js";
```

Change to add `RecostLocalUnreachableError`:

```typescript
import {
  RecostAuthError,
  RecostFatalAuthError,
  RecostLocalUnreachableError,
  type MetricEntry,
  type WindowSummary,
} from "../src/core/types.js";
```

- [ ] **Step 2: Append the new describe block at the end of the file**

After the existing `describe("Transport — 401 auth-failure handling", ...)` block (added in PR #32), append:

```typescript
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
});
```

- [ ] **Step 3: Run the new test to verify it FAILS**

Run: `npm run test -- tests/transport.test.ts -t "single failed reconnect does NOT pause"`

Expected: **FAIL**. The assertions on `_localPaused` and `_reconnectAttempts >= 1` reference state that doesn't exist yet (`_localPaused` is undefined → `expect(undefined).toBe(false)` fails). The `_reconnectAttempts` part may pass (it already exists), but `_localPaused` is the load-bearing red.

If the test passes by accident (e.g., undefined === false coercion in some version), confirm `_localPaused` is genuinely undefined: `console.log(internal._localPaused)` should print `undefined`. The test will become reliably green only after Task 5.

- [ ] **Step 4: Do NOT commit yet — implementation lands in Task 5**

The failing test stays unstaged until Task 5's implementation makes it pass. We commit the test and the implementation together at the end of Task 5 to keep the history bisectable.

---

## Task 5: Implement the local-mode terminal failure lifecycle in `Transport`

**Files:**
- Modify: `src/core/transport.ts`

This is the core change. It adds `_localPaused`, the threshold check in `_scheduleReconnect`, the `_handleLocalUnreachable` helper, and the paused-state early-returns in `_sendOne` and `_connectWs`. It also adds the runtime import for `RecostLocalUnreachableError`.

- [ ] **Step 1: Import the new error class**

Open `src/core/transport.ts`. Find the existing runtime import of error classes added in PR #32:

```typescript
import { RecostAuthError, RecostFatalAuthError } from "./types.js";
```

Change to add `RecostLocalUnreachableError`:

```typescript
import { RecostAuthError, RecostFatalAuthError, RecostLocalUnreachableError } from "./types.js";
```

- [ ] **Step 2: Add the `_localPaused` field**

In the `Transport` class, find the local WebSocket state group (around lines 103–115). Find:

```typescript
  // Local WebSocket state
  private _ws: WebSocket | null = null;
  private _wsQueue: string[] = [];
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _disposed = false;
  /**
   * True once we have already fired an onError notification for the current
   * overflow episode. Reset to false the moment the queue drains back to
   * empty (in the `ws.on("open", ...)` drain handler). Guarantees at most
   * one notification per outage.
   */
  private _dropNotified = false;
```

Add immediately after `_dropNotified`:

```typescript

  /**
   * True once `_reconnectAttempts` has reached `_cfg.maxConsecutiveReconnectFailures`.
   * Never flipped back — recovery is process-restart-only in this PR. Causes
   * `_scheduleReconnect` to no-op and `_sendOne`'s local branch to short-circuit
   * to a silent no-op.
   */
  private _localPaused = false;
```

- [ ] **Step 3: Add the threshold check at the top of `_scheduleReconnect`**

Find the existing `_scheduleReconnect`:

```typescript
  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer !== null) return;
    const delay = this._computeBackoffMs();
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWs();
    }, delay);
  }
```

Replace the entire body with:

```typescript
  private _scheduleReconnect(): void {
    if (this._disposed || this._reconnectTimer !== null) return;

    if (this._reconnectAttempts >= this._cfg.maxConsecutiveReconnectFailures) {
      this._handleLocalUnreachable();
      return;
    }

    const delay = this._computeBackoffMs();
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWs();
    }, delay);
  }
```

The check uses `>=` so the trip happens the next time `_scheduleReconnect` is invoked after `_reconnectAttempts` reaches the threshold value.

- [ ] **Step 4: Add the `_handleLocalUnreachable` helper**

Add a new private method directly **after** `_scheduleReconnect` (before the `// Public API` section divider). Insert:

```typescript

  /**
   * Pause the local transport after the consecutive-failure threshold is
   * reached. Idempotent — the `_localPaused` latch and the early-return in
   * `_scheduleReconnect` prevent re-entry. Emits one stderr line, one
   * `onError(RecostLocalUnreachableError)`, and drops the queued payloads
   * we will never deliver.
   */
  private _handleLocalUnreachable(): void {
    if (this._localPaused) return;          // defensive — should not be reachable
    this._localPaused = true;
    const n = this._reconnectAttempts;

    process.stderr.write(
      `[recost] local WebSocket unreachable after ${n} consecutive reconnect attempts. ` +
      `Restart the process after starting the VS Code extension.\n`,
    );

    if (this._cfg.onError) {
      this._cfg.onError(new RecostLocalUnreachableError(n));
    }

    // We will never drain — release the bounded memory.
    this._wsQueue = [];
  }
```

- [ ] **Step 5: Add the paused-state early-return in `_sendOne`'s local branch**

Find the local branch in `_sendOne` (around line 281, after the cloud branch):

```typescript
      // Local WebSocket
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(body);
      } else {
```

Insert the paused-state check **immediately before** the `if (this._ws?.readyState === ...)` line, so the local branch becomes:

```typescript
      // Local WebSocket
      if (this._localPaused) {
        this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
        return;
      }

      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(body);
      } else {
```

- [ ] **Step 6: Add the defensive paused-state guard in `_connectWs`**

Find `_connectWs`:

```typescript
  private _connectWs(): void {
    if (this._disposed) return;
```

Change the bail line to also check `_localPaused`:

```typescript
  private _connectWs(): void {
    if (this._disposed || this._localPaused) return;
```

This is defensive — the threshold check in `_scheduleReconnect` should already prevent any further `_connectWs` invocation once paused — but cheap.

- [ ] **Step 7: Re-run the Task 4 test to verify it now PASSES**

Run: `npm run test -- tests/transport.test.ts -t "single failed reconnect does NOT pause"`

Expected: **PASS**. `_localPaused` now exists and starts at `false`; the single failed connect bumps `_reconnectAttempts` to ≥ 1 but the threshold (default 20) is not reached.

- [ ] **Step 8: Run the full transport test file**

Run: `npm run test -- tests/transport.test.ts`

Expected: every previously-passing test still passes plus the new one. Specifically: existing "send does not throw when no WebSocket server is running", the queue-and-drain tests, and dispose tests must remain green — none of them assert against `_reconnectAttempts` reaching a threshold.

- [ ] **Step 9: Run lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 10: Commit test + implementation together**

```bash
git add src/core/transport.ts tests/transport.test.ts
git commit -m "feat(transport): pause local WS reconnect loop after N consecutive failures (#22)"
```

---

## Task 6: Threshold-reached test — fires `RecostLocalUnreachableError` + one stderr line + paused

**Files:**
- Modify: `tests/transport.test.ts`

The Task 5 implementation already covers the threshold-trip logic. This task adds the test that asserts it. Uses an explicit `maxConsecutiveReconnectFailures: 2` to keep wall-clock under vitest's default 5s timeout (cumulative backoff for 2 reconnect failures: ~500ms + ~1000ms ≈ 1.5s minimum, ~1.9s with worst-case jitter).

- [ ] **Step 1: Append the test inside the existing describe block**

Inside the `describe("Transport — local-mode terminal failure handling", () => { ... })` block from Task 4, append (just before the closing `});`):

```typescript

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
```

- [ ] **Step 2: Run the new test**

Run: `npm run test -- tests/transport.test.ts -t "threshold reached"`
Expected: **PASS**.

If flaky (e.g., timing-tight on slow CI), bump the `await new Promise` wait to 3000ms and the test timeout to 7_000.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): threshold-reached lifecycle for local WS reconnects (#22)"
```

---

## Task 7: Send-after-pause test — silent no-op

**Files:**
- Modify: `tests/transport.test.ts`

Once paused, further `t.send(...)` calls must not enqueue, must not fire `onError`, must not emit additional stderr, and `lastFlushStatus.status` must be `"error"`.

- [ ] **Step 1: Append the test inside the describe block**

Inside the same `describe("Transport — local-mode terminal failure handling", ...)` block, append (before the closing `});`):

```typescript

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
```

- [ ] **Step 2: Run the new test**

Run: `npm run test -- tests/transport.test.ts -t "after pause, send"`
Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): paused local transport is a silent no-op on send (#22)"
```

---

## Task 8: Counter-reset test — successful connect mid-stream resets the counter

**Files:**
- Modify: `tests/transport.test.ts`

Proves that `_reconnectAttempts = 0` on `ws.on("open")` (existing behavior, unchanged by this PR) is the only counter-reset trigger AND that it actually resets the threshold-trip clock. Uses `maxConsecutiveReconnectFailures: 3`: drive 1 failed connect, then start a server so the next reconnect succeeds (counter resets), then close the server and force 3 fresh failures to trip with `consecutiveFailures: 3` (proving 3 — not 2 — post-success failures were required).

- [ ] **Step 1: Append the test inside the describe block**

```typescript

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
```

- [ ] **Step 2: Run the new test**

Run: `npm run test -- tests/transport.test.ts -t "counter resets"`
Expected: **PASS**.

If flaky on slow CI: add 500ms to the Phase 3 wait and bump test timeout to 9_000.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): successful WS connect resets reconnect-failure counter (#22)"
```

---

## Task 9: Configurable threshold test — `maxConsecutiveReconnectFailures: 1`

**Files:**
- Modify: `tests/transport.test.ts`

Proves the config field is honored end-to-end. Uses the smallest meaningful threshold so the test is fast: `maxConsecutiveReconnectFailures: 1` means after 1 failed reconnect the transport pauses with `consecutiveFailures: 1`.

- [ ] **Step 1: Append the test inside the describe block**

```typescript

  it("maxConsecutiveReconnectFailures: 1 trips after exactly 1 failed reconnect", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        localPort: 49994,
        maxConsecutiveReconnectFailures: 1,
        onError: (e) => errors.push(e),
      });

      // Initial connect fails (~immediate). Reconnect #1 scheduled at ~500ms,
      // fails (~immediate after schedule). Next _scheduleReconnect sees
      // attempts === 1 >= 1 → trips. Total wall-clock < 1.5s.
      await new Promise((r) => setTimeout(r, 1200));

      const unreachable = errors.filter(
        (e) => e instanceof RecostLocalUnreachableError,
      );
      expect(unreachable).toHaveLength(1);
      expect((unreachable[0] as RecostLocalUnreachableError).consecutiveFailures).toBe(1);

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run the new test**

Run: `npm run test -- tests/transport.test.ts -t "maxConsecutiveReconnectFailures: 1"`
Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): configurable maxConsecutiveReconnectFailures honored (#22)"
```

---

## Task 10: Cloud-mode-unaffected + idempotency tests

**Files:**
- Modify: `tests/transport.test.ts`

Two negative tests bundled into one task:
1. Cloud mode (transport with `apiKey`) does not exercise the local-mode threshold path even when `maxConsecutiveReconnectFailures: 1` is set. There is no WebSocket connection, no reconnect timer, no `RecostLocalUnreachableError` fires.
2. Idempotency at the boundary: after the threshold trips, calling `_scheduleReconnect` again (forced via white-box test helper to simulate a stray timer) does NOT fire a second `RecostLocalUnreachableError`.

- [ ] **Step 1: Append both tests inside the describe block**

```typescript

  it("cloud mode is unaffected — local threshold field never triggers an unreachable", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      // Provide apiKey => mode is "cloud". Hostile threshold to make sure
      // the local path can't possibly fire if it's incorrectly reachable.
      const t = new Transport({
        apiKey: "key",
        baseUrl: "http://127.0.0.1:1",   // unroutable, but cloud uses postCloud, not WS
        maxRetries: 0,
        maxConsecutiveReconnectFailures: 1,
        onError: (e) => errors.push(e),
      });

      // Wait long enough that any local-mode reconnect timer would have fired.
      await new Promise((r) => setTimeout(r, 1200));

      // No local reconnect attempts, no unreachable error, no [recost] WS
      // unreachable stderr.
      expect(errors.filter((e) => e instanceof RecostLocalUnreachableError)).toHaveLength(0);
      const wsStderr = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("local WebSocket unreachable"));
      expect(wsStderr).toHaveLength(0);

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("idempotency: forced re-entry into _scheduleReconnect after pause does not fire a second error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const errors: Error[] = [];
    try {
      const t = new Transport({
        localPort: 49993,
        maxConsecutiveReconnectFailures: 1,
        onError: (e) => errors.push(e),
      });

      // Drive to pause.
      await new Promise((r) => setTimeout(r, 1200));

      // Sanity: paused with exactly one error.
      const internal = t as unknown as {
        _localPaused: boolean;
        _scheduleReconnect: () => void;
      };
      expect(internal._localPaused).toBe(true);
      const errorsBefore = errors.filter(
        (e) => e instanceof RecostLocalUnreachableError,
      ).length;
      expect(errorsBefore).toBe(1);

      // Force a second invocation of _scheduleReconnect — simulates a stray
      // timer that somehow survived the pause. The defensive `if (this._localPaused) return;`
      // in _handleLocalUnreachable must prevent a second error.
      internal._scheduleReconnect();

      const errorsAfter = errors.filter(
        (e) => e instanceof RecostLocalUnreachableError,
      ).length;
      expect(errorsAfter).toBe(1);

      // Also assert no second [recost] stderr line.
      const recostStderr = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("local WebSocket unreachable"));
      expect(recostStderr).toHaveLength(1);

      t.dispose();
    } finally {
      stderrSpy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run both tests**

Run: `npm run test -- tests/transport.test.ts -t "cloud mode is unaffected"`
Expected: **PASS**.

Run: `npm run test -- tests/transport.test.ts -t "idempotency"`
Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add tests/transport.test.ts
git commit -m "test(transport): cloud mode unaffected + idempotent unreachable handler (#22)"
```

---

## Task 11: Document the new behavior in `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the configuration table and the existing "Auth failures" subsection**

Run: `grep -n "maxConsecutiveAuthFailures\|Auth failures" README.md`

Expected: one config-table row for `maxConsecutiveAuthFailures` (added in PR #32) and one section header `### Auth failures`.

- [ ] **Step 2: Add the new config row**

Below the row for `maxConsecutiveAuthFailures` in the configuration table, add:

```markdown
| `maxConsecutiveReconnectFailures` | `number` | `20` | Consecutive failed WebSocket reconnect attempts after which the local transport is paused for the lifetime of the process. See "Local-mode unavailability" below. |
```

- [ ] **Step 3: Add a new "Local-mode unavailability" subsection**

Immediately **after** the `### Auth failures` subsection (and before whatever follows it — likely "Custom providers" or another top-level section), add:

```markdown
### Local-mode unavailability

In local mode (no `apiKey`, telemetry sent to the ReCost VS Code extension over WebSocket), the SDK reconnects on disconnect with exponential backoff (500 ms → 30 s, ±25 % jitter). If the extension is never running, the SDK would otherwise spin forever. Instead:

1. After `maxConsecutiveReconnectFailures` (default 20) consecutive failed reconnect attempts, the SDK pauses the local transport for the lifetime of the process.
2. Logs a one-time warning to `stderr`: `[recost] local WebSocket unreachable after 20 consecutive reconnect attempts. Restart the process after starting the VS Code extension.`
3. Calls `onError(new RecostLocalUnreachableError(n))` exactly once, where `n` is the consecutive-failure count at the trip.
4. Subsequent `send()` calls are silent no-ops on the local transport.

Recovery is restart-only: start the VS Code extension, then restart your host process. The counter resets on any successful WebSocket connect, so transient extension restarts do not accumulate toward the threshold.

Hosts can route local-unreachable separately from auth failures by narrowing on the error class:

```ts
import { init, RecostAuthError, RecostFatalAuthError, RecostLocalUnreachableError } from "@recost-dev/node";

init({
  // No apiKey — local mode.
  onError(err) {
    if (err instanceof RecostLocalUnreachableError) log.warn("recost: local extension unreachable; check VS Code");
    else if (err instanceof RecostFatalAuthError) pagerduty.fire(err);
    else if (err instanceof RecostAuthError) log.warn(err);
    else log.debug(err);
  },
});
```
```

- [ ] **Step 4: Run the dist-bundle smoke test**

Run: `npm run build && npm run test`

Expected: all 235 tests pass — 228 baseline (post-PR-#32) + 7 new local-mode tests = 235. (212 prior unit + 9 PR-#32 unit + 7 new = 228 vitest + 7 dist = **235 total**.)

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): document local-mode unavailability + RecostLocalUnreachableError (#22)"
```

---

## Task 12: Final verification + push + PR

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: 235/235 green (228 baseline + 7 new). Build clean. ESM + CJS + DTS all valid.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean dual ESM + CJS + DTS output in `dist/`.

- [ ] **Step 4: Manual diff review**

Run: `git log --oneline main..HEAD` and `git diff main..HEAD --stat`.

Expected commits in order:

1. `feat(types): add RecostLocalUnreachableError + maxConsecutiveReconnectFailures (#22)`
2. `feat(public-api): export RecostLocalUnreachableError (#22)`
3. `feat(transport): wire maxConsecutiveReconnectFailures through ResolvedConfig (#22)`
4. `feat(transport): pause local WS reconnect loop after N consecutive failures (#22)`
5. `test(transport): threshold-reached lifecycle for local WS reconnects (#22)`
6. `test(transport): paused local transport is a silent no-op on send (#22)`
7. `test(transport): successful WS connect resets reconnect-failure counter (#22)`
8. `test(transport): configurable maxConsecutiveReconnectFailures honored (#22)`
9. `test(transport): cloud mode unaffected + idempotent unreachable handler (#22)`
10. `docs(readme): document local-mode unavailability + RecostLocalUnreachableError (#22)`

Files touched: `src/core/types.ts`, `src/core/transport.ts`, `src/index.ts`, `tests/transport.test.ts`, `README.md`.

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin feat/22-ws-terminal-failure
gh pr create --title "feat: local-mode WS terminal failure — pause after N reconnects, typed error (#22)" --body "$(cat <<'EOF'
## Summary
- Adds `RecostLocalUnreachableError` to the public API; sibling to the `RecostAuthError` hierarchy added in PR #32.
- Pauses the local WebSocket transport after `maxConsecutiveReconnectFailures` (default 20) consecutive failed reconnects. Recovery is restart-only.
- One-time `stderr` warning at the threshold, regardless of `debug` flag.
- Existing `onError(err: Error)` signature is unchanged — hosts narrow via `instanceof`.

Closes #22.

Wave 1 of the issue-waves roadmap (`docs/superpowers/roadmap-2026-05-13-issue-waves.md`); Sub-plan B for cross-SDK parity is tracked at recost-dev/middleware-python#32.

## Test plan
- [ ] `npm run test` — 235/235 green (228 baseline + 7 new cases)
- [ ] `npm run lint` — clean
- [ ] `npm run build` — clean dual ESM + CJS + DTS
- [ ] Manually verify in a host process with no VS Code extension running: SDK stops spinning after the threshold, one stderr line is printed, one `onError(RecostLocalUnreachableError)` fires, CPU drops to zero.
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Add `RecostLocalUnreachableError` class | Task 1 |
| Add `maxConsecutiveReconnectFailures?` to `RecostConfig` | Task 1 |
| Re-export error class from `src/index.ts` | Task 2 |
| Resolve `maxConsecutiveReconnectFailures` default 20 in `ResolvedConfig` | Task 3 |
| `_localPaused` flag on `Transport` | Task 5 |
| Threshold check at top of `_scheduleReconnect` | Task 5 |
| `_handleLocalUnreachable` helper (stderr + `onError` + queue clear + latch) | Task 5 |
| Paused-state early-return in `_sendOne` local branch | Task 5 |
| Defensive paused-state guard in `_connectWs` | Task 5 |
| Spec test 1: single failed reconnect doesn't pause | Task 4 |
| Spec test 2: threshold reached fires unreachable + stderr | Task 6 |
| Spec test 3: send after pause is silent no-op | Task 7 |
| Spec test 4: counter reset on successful connect | Task 8 |
| Spec test 5: configurable threshold | Task 9 |
| Spec test 6: cloud mode unaffected | Task 10 (first sub-test) |
| Spec test 7: idempotency at boundary | Task 10 (second sub-test) |
| README documentation | Task 11 |
| Final verification | Task 12 |

All seven spec tests are accounted for across Tasks 4, 6, 7, 8, 9, and 10 (Task 10 bundles two tests).

**Placeholder scan:** no TBDs, no "implement later", no abstract "add error handling" steps. Every code step contains the full code to type/paste.

**Type consistency:** `RecostLocalUnreachableError(consecutiveFailures: number)` — single-arg constructor — is referenced identically in Task 1 (definition), Task 5 (production code at `_handleLocalUnreachable` invocation), and Tasks 4, 6, 7, 8, 9, 10 (tests). `maxConsecutiveReconnectFailures` uses the same camelCase name in `RecostConfig` (Task 1), `ResolvedConfig` (Task 3), `resolveConfig` default (Task 3), `_scheduleReconnect` threshold check (Task 5), and test config (Tasks 6, 7, 8, 9, 10). `_localPaused` and `_reconnectAttempts` are referenced consistently. The error message string from Task 1 (`Recost local WebSocket transport paused after ${consecutiveFailures} consecutive failed reconnects.`) matches the substring asserted in Task 6 (`expect(err.message).toContain("2 consecutive failed reconnects")`).

**Test-flakiness note:** The threshold-trip tests (Tasks 6, 7, 8, 9, 10) depend on real WebSocket connect/close timing and exponential backoff. Wait values are calibrated for the lowest threshold values (1, 2, 3) where total wall-clock stays well under vitest's per-test timeout. If a future change to `_computeBackoffMs` increases the floor (currently 500 ms × 0.75 ≈ 375 ms minimum on the first attempt), revisit the wait values. Each test sets a custom timeout (`5_000`–`7_000` ms) to provide headroom.
