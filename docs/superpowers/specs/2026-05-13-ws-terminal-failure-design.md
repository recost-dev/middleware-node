# Design — WebSocket Terminal Failure (Wave 1, Sub-plan A)

- **Issue:** [#22](https://github.com/recost-dev/middleware-node/issues/22) (Low) — WebSocket reconnect retries forever, no terminal failure mode
- **SDK:** `@recost-dev/node` (this spec). Python parity is tracked separately as Sub-plan B in the same wave.
- **Author / date:** AndresL230, 2026-05-13
- **Status:** Approved for planning

## Problem

In local mode (`apiKey` absent → mode is `local`), `Transport` opens a WebSocket to `ws://127.0.0.1:${localPort}` (the ReCost VS Code extension). When the connection drops or the extension never starts, `_scheduleReconnect` retries with exponential backoff capped at 30s — forever. Every default-config user whose extension isn't running spends a small fraction of host CPU and log noise on doomed reconnects for the lifetime of the process.

The pattern is the same gap PR #32 (#16) closed for the cloud transport's 401 path: there is no terminal failure mode, no typed error to the host, and no observable signal that local mode has gone bad.

Affected code: `src/core/transport.ts` — `_connectWs` (lines 154–190), `_scheduleReconnect` (lines 206–214), `_computeBackoffMs` (lines 200–204), and the local branch of `_sendOne` (lines 281–303).

## Goals

- After **20 consecutive failed reconnect attempts** (configurable via `maxConsecutiveReconnectFailures`), pause the local transport for the lifetime of the process.
- Pass a typed `RecostLocalUnreachableError` (subclass of `RecostError`) through the existing `onError` callback exactly once at the threshold so hosts can route local-unreachable separately from cloud errors.
- Emit a one-time stderr line at the threshold — regardless of `debug` flag — so hosts that haven't wired `onError` still see something.
- Cross-SDK pattern parity: mirror the structural shape of PR #32's 401 lifecycle (latch flag, threshold, one-shot stderr, typed onError, restart-only recovery). Carries cleanly to the Python SDK as Sub-plan B.

## Non-goals (deferred)

- **`handle.reconnect(): Promise<void>`** for in-process recovery without a process restart. Same reasoning as #16 deferred `handle.reconfigure`: the smallest surface lands first; programmatic resume is its own design with subtle mid-flight semantics. Recovery in this PR is restart-only.
- **Per-attempt `onError`.** Only the one-shot at threshold fires. Reconnect failures during normal connection blips (extension restarts, transient network) are too noisy for `onError` and would defeat the "one signal per outage" goal of the existing `_dropNotified` precedent.
- **`installInWorker()` or worker-thread instrumentation.** Out of scope; tracked separately under #11 (Wave 5).
- **Documenting / changing the backoff schedule.** The 500ms → 30s exponential with ±25% jitter stays as-is. The threshold counts attempts, not elapsed time. (At 20 attempts the wall-clock minimum is roughly 4 minutes; in practice ~6–8 minutes including jitter and the 30s cap.)

## Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Contract shape | New `RecostLocalUnreachableError extends RecostError` on existing `onError(err: Error)` callback | Non-breaking; matches the #16 hierarchy pattern; idiomatic JS/TS narrowing |
| Threshold | New optional `RecostConfig.maxConsecutiveReconnectFailures` (default 20) | Issue's recommended default; configurable for tests and stricter hosts |
| Resume | Restart-only; no `handle.reconnect()` | Smallest surface, mirrors #16's restart-only stance |
| Per-attempt `onError` | No — only at threshold | Avoids spam during normal connection blips; matches `_dropNotified` precedent for one-shot signals |
| Counter source | Reuse existing `_reconnectAttempts` (already counts consecutive failed reconnects, resets on successful open) | Avoids a duplicate state field; no behavior change to the counter itself |
| Pause-state behavior | `send()` silent no-op; set `lastFlushStatus.status = "error"`; clear `_wsQueue` | Matches #16's suspended-state behavior; clearing the queue saves bounded memory we'll never drain |
| Class hierarchy depth | `RecostLocalUnreachableError extends RecostError` directly (no intermediate `RecostTransportError` parent) | YAGNI — add the parent only when a third sibling appears |
| stderr policy | One-time line at threshold; `debug` flag ignored | Hosts that never wired `onError` still see one observable signal |

## Public contract additions

### `src/core/types.ts`

A new error class, sibling to `RecostAuthError`:

```ts
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

`RecostConfig` gains one optional field:

```ts
/**
 * Number of consecutive failed WebSocket reconnect attempts after which the
 * SDK pauses the local transport for the lifetime of the process. Recovery
 * requires a process restart with the VS Code extension running.
 * Defaults to 20.
 */
maxConsecutiveReconnectFailures?: number;
```

### `src/index.ts`

Re-export `RecostLocalUnreachableError` next to the existing `RecostError` / `RecostAuthError` / `RecostFatalAuthError` runtime exports.

### Host-side narrowing (the consumer-facing pattern)

```ts
import {
  init,
  RecostAuthError,
  RecostFatalAuthError,
  RecostLocalUnreachableError,
} from "@recost-dev/node";

init({
  // optional apiKey/projectId; absent => local mode
  onError(err) {
    if (err instanceof RecostFatalAuthError) pagerduty.fire(err);
    else if (err instanceof RecostAuthError) log.warn(err);
    else if (err instanceof RecostLocalUnreachableError) log.warn("recost: local extension unreachable; check VS Code");
    else log.debug(err);
  },
});
```

## Internal changes — `src/core/transport.ts`

### New state on `Transport`

```ts
/**
 * True once `_reconnectAttempts` has reached the threshold. Never flipped
 * back — recovery is process-restart-only in this PR. Causes
 * `_scheduleReconnect` to no-op and the local branch of `_sendOne` to
 * short-circuit to a silent no-op.
 */
private _localPaused = false;
```

The existing `_reconnectAttempts` (line 107) already increments on each `_scheduleReconnect` call and resets to 0 on successful WebSocket open (line 171) — it serves as the consecutive-failure counter without modification.

### Resolved config

Add to `ResolvedConfig` and `resolveConfig`:

```ts
maxConsecutiveReconnectFailures: number;
// ...
maxConsecutiveReconnectFailures: config.maxConsecutiveReconnectFailures ?? 20,
```

### `_scheduleReconnect` — threshold check

Add the threshold check before the existing increment + setTimeout:

```ts
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

The check is `>=` (not `>`) so that the first time `_scheduleReconnect` is called with `_reconnectAttempts === threshold`, we trip. With the default `20`, this means: 20 reconnect timers scheduled and fired, all 20 connections failed, the 21st call to `_scheduleReconnect` (in response to the 20th failed close) trips the pause.

### New helper `_handleLocalUnreachable`

Add a private method directly after `_scheduleReconnect`:

```ts
/**
 * Pause the local transport after the consecutive-failure threshold. Idempotent —
 * the `_localPaused` latch and the `_scheduleReconnect` early-return prevent
 * re-entry. Emits one stderr line and one `onError(RecostLocalUnreachableError)`,
 * then drops the queued payloads we'll never deliver.
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

### `_sendOne` local branch — pause early-return

Insert at the top of the local branch (currently lines 281–303), before the WebSocket-open / queue logic:

```ts
// Local WebSocket
if (this._localPaused) {
  this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
  return;
}

// existing: this._ws?.readyState === WebSocket.OPEN ...
```

### `_connectWs` — defensive guard

Add a paused-state bail at the top, alongside the existing `_disposed` bail:

```ts
private _connectWs(): void {
  if (this._disposed || this._localPaused) return;
  // ... existing
}
```

This is defensive — `_scheduleReconnect`'s threshold check should already prevent further `setTimeout` from firing — but cheap to add.

### Lifecycle table

Default threshold = 20. "Reconnect #N" means the N-th call to `_connectWs` that was scheduled by the `setTimeout` in `_scheduleReconnect` (the constructor's initial `_connectWs` call is not counted as a reconnect — its failure is what triggers the first `_scheduleReconnect`).

| Event | `_reconnectAttempts` after | `_wsQueue` | `_localPaused` | stderr | `onError` |
|---|---|---|---|---|---|
| Initial connect fails → first `_scheduleReconnect` runs | 1 | unchanged | no | silent | silent |
| Reconnect #1 through #19 fail (each runs `_scheduleReconnect`) | 2 .. 20 | unchanged | no | silent | silent |
| Reconnect #20 fails → 21st `_scheduleReconnect` sees attempts=20 → trips | 20 (frozen) | **cleared to []** | **yes** | unreachable line | `RecostLocalUnreachableError(20)` |
| Any further would-be reconnect | 20 (frozen) | unchanged | yes | silent | silent (no timer scheduled; defensive bail in `_connectWs`) |
| Successful connect mid-stream (any time before pause) | reset to 0 | drained, then `[]` | no | silent | silent |
| `send()` while paused | unchanged | unchanged | yes | silent | silent (`lastFlushStatus.status = "error"`) |
| `send()` while not paused, ws closed | unchanged | enqueue (or drop-oldest at cap) | no | silent | unchanged (existing overflow-notification path applies) |

## Tests — `tests/transport.test.ts`

All cases live in a new `describe("Transport — local-mode terminal failure handling")` block. Stub `process.stderr.write` per case (and restore in teardown). Use vitest fake timers (`vi.useFakeTimers()`) to drive the reconnect loop without real backoff delays — the existing local-mode tests can serve as the timer-handling reference.

The cases:

1. **Single failed reconnect** → counter is 1, `_localPaused` is false, no `onError`, no stderr, no pause.
2. **Threshold reached (default 20)** → exactly one `RecostLocalUnreachableError(20)` fires through `onError`; exactly one stderr line containing `"local WebSocket unreachable"` and `"20 consecutive"`; `_localPaused` is true.
3. **Send after pause** → `_sendOne` short-circuits: `_wsQueue` does not grow, no `onError` fires, `lastFlushStatus.status === "error"`.
4. **Successful connect resets counter** → 19 fails, then a successful connect, then more fails — the next pause trips at 20 fresh failures (proving the counter reset).
5. **Configurable threshold (`maxConsecutiveReconnectFailures: 2`)** → trips after 2 failed reconnects, fires `RecostLocalUnreachableError(2)`.
6. **Cloud mode is unaffected** → constructing `Transport` with `apiKey` (cloud mode) and a tiny `maxConsecutiveReconnectFailures: 1` produces no WS connection attempts and no `RecostLocalUnreachableError` — the threshold path can't run.
7. **Idempotency at the boundary** → after pause, even if `_scheduleReconnect` is called again (forced via test helper or by another timer somehow surviving), no second `RecostLocalUnreachableError` fires.

(7 tests total — slightly less than #16's 9 because the lifecycle is simpler: one-shot at threshold, no `RecostFatalLocalUnreachableError` sibling, no four-way counter-reset matrix to enumerate since there's only one reset trigger.)

## Documentation — `README.md`

Add to the configuration section:

- `maxConsecutiveReconnectFailures` row in the config table.
- A new "Local-mode unavailability" subsection (or a new entry alongside the existing "Auth failures" subsection added in PR #32) explaining:
  - What triggers the pause (20 consecutive failed WS reconnects).
  - The one-time stderr line and the typed `onError(RecostLocalUnreachableError)` notification.
  - Recovery is restart-only; suggested operator action (start the VS Code extension, then restart the host process).

## Files touched

| File | Change |
|---|---|
| `src/core/types.ts` | Add `RecostLocalUnreachableError extends RecostError`; add `maxConsecutiveReconnectFailures?` to `RecostConfig` |
| `src/core/transport.ts` | Add `_localPaused` flag; add threshold check + pause-handler in `_scheduleReconnect`; add `_handleLocalUnreachable`; add pause-early-return to `_sendOne` local branch and `_connectWs`; resolve new config field |
| `src/index.ts` | Re-export `RecostLocalUnreachableError` |
| `tests/transport.test.ts` | Add 7 cases in a new describe block |
| `README.md` | Document the new config field, the new error class, the recovery path |

## Verification (mirrors issue's verification criteria)

- Run an app with local mode and no extension for the duration the threshold buys (default 20 attempts ≈ 6–8 minutes wall-clock with 30s cap + jitter). Confirm:
  - The SDK stops scheduling reconnect timers after the threshold.
  - One stderr line is printed at the threshold; nothing further.
  - One `onError(RecostLocalUnreachableError)` fires; nothing further.
  - CPU drops to zero (no more setTimeout churn).
- `npm run test` → all existing tests still pass; 7 new cases pass.
- `npm run lint` → clean.
- `npm run build` → clean dual ESM + CJS + DTS output.
