# Design — 401 Auth-Failure Handling

- **Issue:** [#16](https://github.com/recost-dev/middleware-node/issues/16) (High) — Middleware silently drops windows on 401, no escalation path
- **SDK:** `@recost-dev/node` (this spec); Python parity tracked separately in `middleware-python`
- **Author / date:** AndresL230, 2026-05-13
- **Status:** Approved for planning

## Problem

When `api.recost.dev` returns 401 (invalid or revoked API key), the Node SDK correctly skips retry (4xx is non-retriable), drops the window, logs a generic `console.warn`, and fires `onError(new Error(...))`. It then keeps trying on the next flush. There is no mechanism to:

1. Stop trying after N consecutive 401s — each subsequent flush eats the same 401 and discards more data.
2. Notify the host application that authentication specifically is failing (vs. a generic transient error).
3. Surface a clear "your key was revoked" message to the developer without requiring them to wire `onError` first.

User-visible failure mode: rotate an API key, forget to update SDK config → dashboard goes flat → user assumes the dashboard is broken.

Affected code: `src/core/transport.ts` — `postCloud` returns `{ ok: false, status: 401 }`; `_reportRejection` warns and fires `onError` but never escalates or stops.

## Goals

- After **5 consecutive 401s** (configurable via `maxConsecutiveAuthFailures`), suspend the cloud transport for the lifetime of the process.
- Pass typed `Error` subclasses through the existing `onError` callback so hosts can route auth failures to alerting separately from generic transport errors.
- Emit a one-time stderr warning on the first 401 of an episode and a second stderr line at fatal-suspend — regardless of the `debug` flag — so hosts that haven't wired `onError` still see something.
- Cross-SDK parity: mirror the `RecostError` / `RecostAuthError` / `RecostFatalAuthError` hierarchy already declared in `middleware-python/recost/_types.py`.

## Non-goals (deferred)

- **`handle.reconfigure(partial: Partial<RecostConfig>)`** for in-process API-key rotation. Recovery from the suspended state in this PR is "restart the process." Programmatic resume is captured as future work; mid-flight semantics deserve their own design.
- **403 (project-access mismatch) suspension.** Keys are not project-scoped, so a 403 represents a different recoverable shape (key valid, projectId wrong) with potentially different retry semantics. Out of scope here; revisit if 403-loops materialize in practice.
- **Python transport wiring.** Python's `_types.py` already declares the error classes; wiring them into `_transport.py` is tracked in middleware-python.

## Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Contract shape | `Error` subclass hierarchy on existing `onError(err: Error)` callback | Non-breaking; idiomatic in JS/TS via `instanceof`; matches Python's pre-declared hierarchy |
| Threshold | New optional `RecostConfig.maxConsecutiveAuthFailures` (default 5) | Configurable for tests and stricter hosts; mirrors what we'd want to expose in Python |
| Resume | Restart-only; no `handle.reconfigure` | Smallest surface, lowest risk; `reconfigure` is its own design |
| Suspension scope | 401 only (not 403) | API keys aren't project-scoped; 403 is a separate recoverable shape |
| Counter reset | Anything-not-401 resets to 0 | Literal reading of "consecutive 401s"; avoids tripping during unrelated outages |
| stderr policy | Two lines per episode: first 401, fatal suspend; silent in between | Honors issue's "one-time" intent; still announces both state changes for hosts that didn't wire `onError` |
| Suspended-state behavior | `send()` silent no-op; set `lastFlushStatus.status = "error"` | Host can poll; no further `onError` spam (host already knows) |

## Public contract additions

### `src/core/types.ts`

```ts
export class RecostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecostError";
  }
}

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

`RecostConfig` gains one optional field:

```ts
/**
 * Number of consecutive 401 responses from the cloud API after which the SDK
 * suspends cloud telemetry for the lifetime of the process. Recovery requires
 * rotating `apiKey` in config and restarting. Defaults to 5.
 */
maxConsecutiveAuthFailures?: number;
```

### `src/index.ts`

Re-export `RecostError`, `RecostAuthError`, `RecostFatalAuthError`.

### Host-side narrowing (the consumer-facing pattern)

```ts
import { init, RecostAuthError, RecostFatalAuthError } from "@recost-dev/node";

init({
  apiKey,
  projectId,
  onError(err) {
    if (err instanceof RecostFatalAuthError) pagerduty.fire(err);
    else if (err instanceof RecostAuthError) log.warn(err);
    else log.debug(err);
  },
});
```

## Internal changes — `src/core/transport.ts`

### New state on `Transport`

```ts
private _consecutiveAuthFailures = 0;
private _cloudSuspended = false;
```

Both are per-instance. `init()` builds a fresh `Transport`, so re-initialization gives a clean slate.

### Resolved config

Add to `ResolvedConfig` and `resolveConfig`:

```ts
maxConsecutiveAuthFailures: number;
// ...
maxConsecutiveAuthFailures: config.maxConsecutiveAuthFailures ?? 5,
```

### `_sendOne` cloud-mode lifecycle

Early return at the top of the cloud branch:

```ts
if (this._cloudSuspended) {
  this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
  return;
}
```

Replace the existing 401 handling with:

```ts
if (result.status === 401) {
  this._consecutiveAuthFailures += 1;
  const n = this._consecutiveAuthFailures;
  const threshold = this._cfg.maxConsecutiveAuthFailures;
  const isFirst = n === 1;
  const isFatal = n >= threshold;

  if (isFirst) {
    process.stderr.write(
      `[recost] HTTP 401 — API key rejected. Telemetry will stop after ${threshold} consecutive failures. ` +
      `Check your apiKey at https://recost.dev/dashboard/account.\n`,
    );
  }

  if (isFatal) {
    this._cloudSuspended = true;
    process.stderr.write(
      `[recost] cloud transport suspended after ${n} consecutive auth failures. ` +
      `Restart the process after rotating apiKey.\n`,
    );
    this._cfg.onError?.(new RecostFatalAuthError(401, n));
  } else {
    this._cfg.onError?.(new RecostAuthError(401, n));
  }

  this._lastFlushStatus = { status: "error", windowSize, timestamp: Date.now() };
  return;
}
```

Every other outcome from `postCloud` (2xx success, non-401 4xx, 5xx-after-retries, network throw) resets the counter:

```ts
this._consecutiveAuthFailures = 0;
```

Existing `_reportRejection` is kept for 403/404/422/etc.; its 401 branch is removed (now handled above). `postCloud` itself is unchanged.

### Lifecycle table

| Event | Counter | Suspended? | stderr | onError |
|---|---|---|---|---|
| 1st 401 | 1 | no | warning line | `RecostAuthError(401, 1)` |
| 2nd–4th 401 (default threshold 5) | 2..4 | no | silent | `RecostAuthError(401, n)` |
| 5th 401 | 5 | **yes** | suspension line | `RecostFatalAuthError(401, 5)` |
| 6th+ flush attempt | unchanged | yes | silent | silent (no-op) |
| 2xx success between 401s | reset to 0 | no | silent | silent |
| 403/404/422/5xx between 401s | reset to 0 | no | existing warn | existing `onError` |
| Network throw between 401s | reset to 0 | no | existing warn | existing `onError` |

## Tests — `tests/transport.test.ts`

Stub `process.stderr.write` per case (and restore in teardown). All cases use the existing `mockFetch` helper.

1. **Single 401** → `RecostAuthError(401, 1)` fires, one stderr line, `lastFlushStatus.status === "error"`, transport not suspended.
2. **Five consecutive 401s** → `RecostAuthError` fires for attempts 1–4, `RecostFatalAuthError(401, 5)` fires for attempt 5, second stderr line at attempt 5, transport suspended.
3. **6th send after suspension** → silent no-op; `mockFetch` not called; `lastFlushStatus.status === "error"`; no additional `onError` invocations.
4. **Four 401s then 2xx** → counter resets; next 401 reports `consecutiveFailures: 1`.
5. **Three 401s then 403** → counter resets; existing 403 `onError` behavior preserved.
6. **Three 401s then 5xx-after-retries-exhausted** → counter resets.
7. **Three 401s then a network error throw** → counter resets.
8. **`maxConsecutiveAuthFailures: 2`** → fatal trips after 2 instead of 5 (confirms config wire-up).
9. **Local mode never suspends** (no `apiKey` → no 401 path).
10. **Update existing 401 test** to assert the new error type (`instanceof RecostAuthError`) instead of generic `Error`.

## Documentation — `README.md`

Add to the "Configuration" section:

- `maxConsecutiveAuthFailures` row in the config table.
- Short subsection on the `RecostError` / `RecostAuthError` / `RecostFatalAuthError` hierarchy with the host-side narrowing snippet.
- One sentence: "If the cloud transport is suspended, restart the process after rotating `apiKey`."

## Files touched

| File | Change |
|---|---|
| `src/core/types.ts` | Add three error classes; add `maxConsecutiveAuthFailures?` to `RecostConfig` |
| `src/core/transport.ts` | Add counter + suspended flag; 401 lifecycle in `_sendOne`; suspended-state early return; resolve new config field |
| `src/index.ts` | Re-export the three error classes |
| `tests/transport.test.ts` | Add 9 cases; update 1 existing assertion |
| `README.md` | Document the new config field, the error hierarchy, and the recovery path |

## Verification (mirrors issue's verification criteria)

- Configure an invalid key, run for 5 flush intervals → SDK stops trying after 5 attempts, `onError` fires with `RecostFatalAuthError` carrying `status: 401`, `consecutiveFailures: 5`.
- A single stderr line is printed on the first 401; a second on fatal-suspend; nothing in between.
- After suspension, no further requests reach `mockFetch`.
- `npm run test` → all existing tests still pass; 9 new cases pass.
- `npm run lint` → clean.
- `npm run build` → clean dual ESM + CJS + DTS output.
