# Wire-Format Contract Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down the cross-SDK `WindowSummary` wire format on the Node side. Drop the redundant `projectId` field from the body (the URL path is the source of truth), and pin the timestamp wire format to `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` (ISO 8601, millisecond precision, UTC `Z` suffix) via a dedicated helper, a JSDoc note, and a strict contract-test regex. Closes [recost-dev/middleware-node#17](https://github.com/recost-dev/middleware-node/issues/17) and [recost-dev/middleware-node#20](https://github.com/recost-dev/middleware-node/issues/20). Bundled single PR.

**Architecture:** `WindowSummary` loses one field (`projectId`); `RecostConfig.projectId` is unchanged (still required for cloud mode, still used by `Transport` to build the URL path). A new `src/core/time.ts` module exports a single `isoNow()` helper whose JSDoc documents the wire-format contract; `aggregator.ts` and `interceptor.ts` call it instead of `new Date().toISOString()` directly. Node already emits the recommended format — this PR is preventing future drift, not fixing a bug. The Python-side mirror and an optional API-side mismatch validator are filed as follow-up issues.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, tsup dual ESM + CJS build.

---

## File Structure

- **Create** `src/core/time.ts` — single-function module exporting `isoNow(): string`. Comment captures the wire-format contract so future maintainers have one canonical place to read the rule.
- **Modify** `src/core/aggregator.ts` — drop `_projectId` field, drop `projectId` from `AggregatorConfig`, drop `projectId` line from the `flush()` return; import and call `isoNow()` instead of `new Date().toISOString()`.
- **Modify** `src/core/interceptor.ts` — call `isoNow()` instead of `new Date().toISOString()`.
- **Modify** `src/core/types.ts` — drop `projectId: string` from `WindowSummary`; add JSDoc to `windowStart` / `windowEnd` documenting the locked wire format.
- **Modify** `src/init.ts` — stop passing `projectId` to the `Aggregator` constructor. (Still passes it through to `Transport` via the `...config` spread — unchanged.)
- **Modify** `tests/contract.test.ts` — drop `"projectId"` from `EXPECTED_TOP_LEVEL_KEYS`; add a new `it` asserting the strict ms+Z regex on both timestamps; add a new `it` asserting `JSON.stringify(summary)` does not contain the substring `"projectId"`.
- **Modify** `tests/aggregator.test.ts` — drop `projectId` from `Aggregator` constructor calls (1 spot in basic-flush block, 1 in metadata block); drop the `summary.projectId` assertions in the metadata block (2 spots); rename one test description.
- **Modify** `tests/init.test.ts` — drop the `summary.projectId` assertion in the "forwards … to the WindowSummary" test; rename the test description to drop "projectId and".
- **Modify** `tests/transport.test.ts` — drop `projectId` default from the `makeSummary` helper; rename the per-message `projectId` discriminator to `environment` in the local-mode tests (~13 spots); drop one `expect(parsed.projectId).toBe("proj-1")` assertion in the cloud-POST test (the `RecostConfig.projectId` arg passed to `Transport` constructors stays unchanged — still drives the URL path).
- **Modify** `README.md` — only if README documents the body shape today; otherwise skip. Verified during Task 6.

`Transport` and the rest of the cloud-mode test path are deliberately unchanged: the URL still resolves to `${baseUrl}/projects/${projectId}/telemetry`.

---

## Task 1: Create `src/core/time.ts` with the `isoNow()` helper

**Files:**
- Create: `src/core/time.ts`

A single-function module. The implementation is `() => new Date().toISOString()`; the *value* is the contract comment giving future maintainers one canonical place to find the wire-format rule.

- [ ] **Step 1: Create the new file**

Create `src/core/time.ts` with exactly this content:

```typescript
/**
 * Wire-format timestamp helper.
 *
 * The cross-SDK contract for `WindowSummary.windowStart` and `WindowSummary.windowEnd`
 * is **ISO 8601, millisecond precision, UTC `Z` suffix** — for example
 * `2026-05-14T12:00:00.000Z`. Asserted in `tests/contract.test.ts`.
 *
 * Do not change this format without updating both:
 *   - `tests/contract.test.ts` (Node), and
 *   - the matching `test_contract.py` in `recost-dev/middleware-python`.
 *
 * `Date.prototype.toISOString()` already produces this exact format, so this
 * helper is a thin wrapper. Its job is to keep the rule documented in one place.
 */
export function isoNow(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 2: Run lint and tests**

Run: `npm run lint && npm run test`
Expected: lint clean; **228/228 vitest** + **7/7 dist** still pass (the new file is not yet imported anywhere, so it adds zero behavior).

- [ ] **Step 3: Commit**

```bash
git add src/core/time.ts
git commit -m "feat(time): add isoNow() helper documenting the cross-SDK wire format (#20)"
```

---

## Task 2: Refactor `aggregator.ts` and `interceptor.ts` to call `isoNow()`

**Files:**
- Modify: `src/core/aggregator.ts`
- Modify: `src/core/interceptor.ts`

Pure mechanical refactor — no behavior change. `new Date().toISOString()` and `isoNow()` produce identical strings, so all 228 existing tests stay green. The point is to route both timestamp emission sites through the helper that documents the contract.

- [ ] **Step 1: Add the import to `aggregator.ts`**

Open `src/core/aggregator.ts`. Find the existing import at the top:

```typescript
import type { MetricEntry, RawEvent, WindowSummary } from "./types.js";
```

Add directly below it:

```typescript
import { isoNow } from "./time.js";
```

- [ ] **Step 2: Replace the two `new Date().toISOString()` call sites in `aggregator.ts`**

In the same file, find lines 154–155 inside `flush()`:

```typescript
    const windowStart = this._windowStart ?? new Date().toISOString();
    const windowEnd = new Date().toISOString();
```

Replace with:

```typescript
    const windowStart = this._windowStart ?? isoNow();
    const windowEnd = isoNow();
```

- [ ] **Step 3: Add the import to `interceptor.ts`**

Open `src/core/interceptor.ts`. Locate the existing imports near the top of the file. Add (alongside existing relative imports):

```typescript
import { isoNow } from "./time.js";
```

(If the file already groups type imports separately, place this with the value imports.)

- [ ] **Step 4: Replace the `new Date().toISOString()` call site in `interceptor.ts`**

In the same file, find line 121 inside the RawEvent constructor function:

```typescript
    timestamp: new Date().toISOString(),
```

Replace with:

```typescript
    timestamp: isoNow(),
```

- [ ] **Step 5: Run lint and the full test suite**

Run: `npm run lint && npm run test`
Expected: lint clean; **228/228 vitest** + **7/7 dist** all pass. The behavior is unchanged — both files now route through the helper.

- [ ] **Step 6: Commit**

```bash
git add src/core/aggregator.ts src/core/interceptor.ts
git commit -m "refactor(aggregator,interceptor): route timestamps through isoNow() (#20)"
```

---

## Task 3: Tighten the contract test with the ms+Z regex assertion

**Files:**
- Modify: `tests/contract.test.ts`

This is the regression guard for #20 on the Node side. The test asserts the wire format strictly. It passes from the moment it's added (Node already emits the right format), but if anyone changes the helper or the call sites in the future, this test fails.

- [ ] **Step 1: Add the new assertion**

Open `tests/contract.test.ts`. Find the existing `it("uses ISO-8601 strings for windowStart and windowEnd", ...)` test (around line 106). Inside the same `describe("contract — WindowSummary top-level", ...)` block, add a new `it` block immediately after the existing ISO test:

```typescript

  it("windowStart and windowEnd match the locked wire format (ms precision, UTC Z)", () => {
    const summary = buildFlushPayload();
    // The cross-SDK wire-format contract: ISO 8601, millisecond precision, UTC "Z".
    // Mirrors the assertion in middleware-python/tests/test_contract.py.
    const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(summary.windowStart).toMatch(ISO_MS_Z);
    expect(summary.windowEnd).toMatch(ISO_MS_Z);
  });
```

- [ ] **Step 2: Run the new test**

Run: `npm run test -- tests/contract.test.ts -t "match the locked wire format"`
Expected: **PASS**. Node already emits ms+Z via `new Date().toISOString()`.

- [ ] **Step 3: Run the full test suite**

Run: `npm run test`
Expected: **229/229 vitest** + **7/7 dist** = 236/236 total. (228 baseline + 1 new.)

- [ ] **Step 4: Commit**

```bash
git add tests/contract.test.ts
git commit -m "test(contract): assert windowStart/windowEnd match locked ms+Z wire format (#20)"
```

---

## Task 4: TDD red — assert `WindowSummary` body has no `projectId`

**Files:**
- Modify: `tests/contract.test.ts`

Two changes to the contract test:
1. Remove `"projectId"` from `EXPECTED_TOP_LEVEL_KEYS` — the existing top-level-fields test will fail because the production payload still includes `projectId`.
2. Add a new `it` asserting `JSON.stringify(summary)` does not contain the substring `"projectId"`. Belt-and-suspenders — catches accidental re-introduction even if the type were correct but the implementation diverged.

Both turn **red** here; Task 5 turns them green.

- [ ] **Step 1: Drop `"projectId"` from `EXPECTED_TOP_LEVEL_KEYS`**

Open `tests/contract.test.ts`. Find the constant near the top of the file:

```typescript
const EXPECTED_TOP_LEVEL_KEYS = [
  "projectId",
  "environment",
  "sdkLanguage",
  "sdkVersion",
  "windowStart",
  "windowEnd",
  "metrics",
].sort();
```

Replace with:

```typescript
const EXPECTED_TOP_LEVEL_KEYS = [
  "environment",
  "sdkLanguage",
  "sdkVersion",
  "windowStart",
  "windowEnd",
  "metrics",
].sort();
```

- [ ] **Step 2: Add the no-`projectId`-substring assertion**

Inside the same `describe("contract — WindowSummary top-level", ...)` block, immediately after the ms+Z regex test added in Task 3, append:

```typescript

  it("does not include projectId in the body — URL path is the source of truth", () => {
    const summary = buildFlushPayload();
    const onWire = JSON.stringify(summary);
    // Belt-and-suspenders: even if the WindowSummary type ever drifted to
    // include projectId again, the wire payload itself must not carry it.
    // The API extracts projectId from the URL path; the body field would be
    // dead weight at best and a silent mismatch source at worst.
    expect(onWire).not.toContain("projectId");
  });
```

- [ ] **Step 3: Run the contract tests to verify they FAIL**

Run: `npm run test -- tests/contract.test.ts`

Expected: **at least 2 failures**:
1. `contract — WindowSummary top-level > has exactly the documented top-level fields, no more, no less` — fails because actual on-wire keys still include `projectId` while expected list no longer does.
2. `contract — WindowSummary top-level > does not include projectId in the body — URL path is the source of truth` — fails because `JSON.stringify(summary)` still contains `"projectId"`.

If either passes, the production code somehow already dropped `projectId` and there's nothing to do for #17 — investigate before proceeding to Task 5.

- [ ] **Step 4: Do NOT commit yet**

The failing test stays unstaged until Task 5's implementation makes it pass. We commit the test changes and the production change together at the end of Task 5 to keep history bisectable.

---

## Task 5: TDD green — drop `projectId` from `WindowSummary` body and fix downstream tests

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/aggregator.ts`
- Modify: `src/init.ts`
- Modify: `tests/aggregator.test.ts`
- Modify: `tests/init.test.ts`
- Modify: `tests/transport.test.ts`

The production change is small: drop one field from the type, drop the supporting state from `Aggregator`, stop passing the value from `init.ts`. That breaks four downstream tests at TypeScript-compile time — they reference `summary.projectId` (now `never`) or pass `projectId` to `AggregatorConfig` (no longer accepted) or `WindowSummary` literals (field gone). All fixes are mechanical and land in the same commit so every commit in the branch type-checks.

- [ ] **Step 1: Drop `projectId` from `WindowSummary` and add wire-format JSDoc**

Open `src/core/types.ts`. Find the `WindowSummary` interface (around line 73):

```typescript
/** What the aggregator produces on flush. Sent to the cloud API or local extension. */
export interface WindowSummary {
  /** ReCost project ID from config. */
  projectId: string;
  /** Environment tag (e.g. "development", "production") from config. */
  environment: string;
  /** Always "node" for this SDK. */
  sdkLanguage: string;
  /** Package version from package.json. */
  sdkVersion: string;
  /** ISO 8601 timestamp of the first event in this window. */
  windowStart: string;
  /** ISO 8601 timestamp of when the flush occurred. */
  windowEnd: string;
  /** One entry per unique provider + endpoint + method observed during the window. */
  metrics: MetricEntry[];
}
```

Replace with:

```typescript
/** What the aggregator produces on flush. Sent to the cloud API or local extension. */
export interface WindowSummary {
  /** Environment tag (e.g. "development", "production") from config. */
  environment: string;
  /** Always "node" for this SDK. */
  sdkLanguage: string;
  /** Package version from package.json. */
  sdkVersion: string;
  /**
   * ISO 8601 timestamp of the first event in this window.
   * Wire-format contract: millisecond precision, UTC `Z` suffix
   * (e.g. `2026-05-14T12:00:00.000Z`). See `src/core/time.ts`.
   */
  windowStart: string;
  /**
   * ISO 8601 timestamp of when the flush occurred.
   * Wire-format contract: millisecond precision, UTC `Z` suffix
   * (e.g. `2026-05-14T12:00:30.000Z`). See `src/core/time.ts`.
   */
  windowEnd: string;
  /** One entry per unique provider + endpoint + method observed during the window. */
  metrics: MetricEntry[];
}
```

`projectId` is intentionally absent. The URL path `${baseUrl}/projects/${projectId}/telemetry` carries it. `RecostConfig.projectId` is unchanged.

- [ ] **Step 2: Drop `projectId` from `AggregatorConfig`, the `_projectId` field, and the `flush()` return**

Open `src/core/aggregator.ts`.

(a) Find `AggregatorConfig` (around line 50–59) and remove the `projectId` field. Specifically, change:

```typescript
export interface AggregatorConfig {
  /** Attached to every WindowSummary. Defaults to "". */
  projectId?: string;
  /** Attached to every WindowSummary. Defaults to "development". */
  environment?: string;
  /** SDK package version string. Defaults to "0.0.0". */
  sdkVersion?: string;
  /** Maximum unique triplets per window. Defaults to MAX_BUCKETS (2000). */
  maxBuckets?: number;
}
```

To:

```typescript
export interface AggregatorConfig {
  /** Attached to every WindowSummary. Defaults to "development". */
  environment?: string;
  /** SDK package version string. Defaults to "0.0.0". */
  sdkVersion?: string;
  /** Maximum unique triplets per window. Defaults to MAX_BUCKETS (2000). */
  maxBuckets?: number;
}
```

(b) In the `Aggregator` class, find:

```typescript
  private readonly _projectId: string;
  private readonly _environment: string;
```

Change to:

```typescript
  private readonly _environment: string;
```

(c) In the constructor, find:

```typescript
  constructor(config: AggregatorConfig = {}) {
    this._projectId = config.projectId ?? "";
    this._environment = config.environment ?? "development";
    this._sdkVersion = config.sdkVersion ?? "0.0.0";
    this._maxBuckets = config.maxBuckets ?? MAX_BUCKETS;
  }
```

Change to:

```typescript
  constructor(config: AggregatorConfig = {}) {
    this._environment = config.environment ?? "development";
    this._sdkVersion = config.sdkVersion ?? "0.0.0";
    this._maxBuckets = config.maxBuckets ?? MAX_BUCKETS;
  }
```

(d) In `flush()` find the return literal (around lines 183–191):

```typescript
    return {
      projectId: this._projectId,
      environment: this._environment,
      sdkLanguage: "node",
      sdkVersion: this._sdkVersion,
      windowStart,
      windowEnd,
      metrics,
    };
```

Change to:

```typescript
    return {
      environment: this._environment,
      sdkLanguage: "node",
      sdkVersion: this._sdkVersion,
      windowStart,
      windowEnd,
      metrics,
    };
```

- [ ] **Step 3: Stop passing `projectId` to `Aggregator` from `init.ts`**

Open `src/init.ts`. Find the `Aggregator` instantiation (around lines 64–69):

```typescript
  const aggregator = new Aggregator({
    ...(config.projectId !== undefined && { projectId: config.projectId }),
    ...(config.environment !== undefined && { environment: config.environment }),
    sdkVersion: "0.1.0",
    maxBuckets,
  });
```

Change to:

```typescript
  const aggregator = new Aggregator({
    ...(config.environment !== undefined && { environment: config.environment }),
    sdkVersion: "0.1.0",
    maxBuckets,
  });
```

`config.projectId` continues to flow into `Transport` via the unchanged `new Transport({ ...config, maxBuckets })` line directly below — no change there.

- [ ] **Step 4: Fix `tests/aggregator.test.ts`**

Open `tests/aggregator.test.ts`.

(a) Around line 34 inside `describe("Aggregator — basic flush behavior", ...)`, find:

```typescript
    const agg = new Aggregator({ projectId: "p1", environment: "test" });
```

Change to:

```typescript
    const agg = new Aggregator({ environment: "test" });
```

(b) In `describe("Aggregator — metadata", ...)`, find the test at line 242:

```typescript
  it("WindowSummary includes constructor config values", () => {
    const agg = new Aggregator({
      projectId: "proj_123",
      environment: "production",
      sdkVersion: "1.2.3",
    });
    agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.projectId).toBe("proj_123");
    expect(summary.environment).toBe("production");
    expect(summary.sdkVersion).toBe("1.2.3");
    expect(summary.sdkLanguage).toBe("node");
  });
```

Change to:

```typescript
  it("WindowSummary includes constructor config values", () => {
    const agg = new Aggregator({
      environment: "production",
      sdkVersion: "1.2.3",
    });
    agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.environment).toBe("production");
    expect(summary.sdkVersion).toBe("1.2.3");
    expect(summary.sdkLanguage).toBe("node");
  });
```

(c) Find the next test at line 256:

```typescript
  it("defaults: projectId empty, environment 'development', sdkVersion '0.0.0'", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.projectId).toBe("");
    expect(summary.environment).toBe("development");
    expect(summary.sdkVersion).toBe("0.0.0");
  });
```

Change to:

```typescript
  it("defaults: environment 'development', sdkVersion '0.0.0'", () => {
    const agg = new Aggregator();
    agg.ingest(makeEvent());
    const summary = agg.flush()!;
    expect(summary.environment).toBe("development");
    expect(summary.sdkVersion).toBe("0.0.0");
  });
```

- [ ] **Step 5: Fix `tests/init.test.ts`**

Open `tests/init.test.ts`. Find the test at line 609:

```typescript
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
```

Change to:

```typescript
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
```

(`projectId: "my-project"` is intentionally retained in the `init()` call. Local mode does not require it; it's a no-op pass-through here, harmless to leave in. The `summary.projectId` assertion is what we drop.)

- [ ] **Step 6: Fix `tests/transport.test.ts`**

Open `tests/transport.test.ts`. The discriminator pattern in the local-mode tests uses `projectId` to label payloads so the receiver can verify ordering. Switch the discriminator to `environment` (which is still on `WindowSummary`). Cloud-mode `Transport` constructors keep `projectId` — that's `RecostConfig.projectId`, unchanged.

(a) The `makeSummary` helper (around line 29):

```typescript
function makeSummary(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    projectId: "proj-1",
    environment: "test",
    sdkLanguage: "node",
    sdkVersion: "0.1.0",
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-01T00:00:30.000Z",
    metrics: [],
    ...overrides,
  };
}
```

Change to:

```typescript
function makeSummary(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    environment: "test",
    sdkLanguage: "node",
    sdkVersion: "0.1.0",
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-01T00:00:30.000Z",
    metrics: [],
    ...overrides,
  };
}
```

(b) Cloud test at line 161 (`"POSTs summary as JSON with correct Authorization header"`). Find:

```typescript
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.auth).toBe("Bearer test-key");
    const parsed = JSON.parse(req.body) as WindowSummary;
    expect(parsed.projectId).toBe("proj-1");
```

Change to (drop the final assertion — the URL-path test directly below already covers projectId-as-URL):

```typescript
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.auth).toBe("Bearer test-key");
    const parsed = JSON.parse(req.body) as WindowSummary;
    expect(parsed.environment).toBe("test");
```

The new assertion verifies the body still parses as a valid `WindowSummary` and carries the helper's default `environment` value — keeps the test asserting on body content without depending on the removed field. Note the `Transport` constructor's `projectId: "proj-1"` stays as-is — it's `RecostConfig.projectId`, used to build the URL path tested by the next test.

(c) Local-mode discriminator renames. Mechanical replacement — every occurrence of `projectId` used as a `Partial<WindowSummary>` value or read off a parsed `WindowSummary` becomes `environment`. The `Transport` constructor `projectId` arguments stay.

Find at line 307: `await t.send(makeSummary({ projectId: "ws-test" }));`
Change to: `await t.send(makeSummary({ environment: "ws-test" }));`

Find at line 315: `expect(received.projectId).toBe("ws-test");`
Change to: `expect(received.environment).toBe("ws-test");`

Find at lines 327–328:
```typescript
    await t.send(makeSummary({ projectId: "queued-1" }));
    await t.send(makeSummary({ projectId: "queued-2" }));
```
Change to:
```typescript
    await t.send(makeSummary({ environment: "queued-1" }));
    await t.send(makeSummary({ environment: "queued-2" }));
```

Find at line 339: `await t2.send(makeSummary({ projectId: "direct" }));`
Change to: `await t2.send(makeSummary({ environment: "direct" }));`

Find at line 349: `expect(parsed.projectId).toBe("direct");`
Change to: `expect(parsed.environment).toBe("direct");`

Find at line 531: `await t.send(makeSummary({ projectId: \`p-${i}\` }));`
Change to: `await t.send(makeSummary({ environment: \`p-${i}\` }));`

Find at line 542: `await t.send(makeSummary({ projectId: \`p-${i}\` }));`
Change to: `await t.send(makeSummary({ environment: \`p-${i}\` }));`

Find at line 560: `const ids = ws.messages.map((m) => (JSON.parse(m) as WindowSummary).projectId);`
Change to: `const ids = ws.messages.map((m) => (JSON.parse(m) as WindowSummary).environment);`

Find at line 573: `await t.send(makeSummary({ projectId: \`e1-${i}\` }));`
Change to: `await t.send(makeSummary({ environment: \`e1-${i}\` }));`

Find at line 592: `void t.send(makeSummary({ projectId: "probe" })).then(() => {`
Change to: `void t.send(makeSummary({ environment: "probe" })).then(() => {`

Find at line 603: `await t.send(makeSummary({ projectId: \`e2-${i}\` }));`
Change to: `await t.send(makeSummary({ environment: \`e2-${i}\` }));`

Verification helper after the edits — run:

```bash
grep -n "projectId" tests/transport.test.ts
```

Expected: only `Transport` constructor arguments remain (around lines 165 and 186) — those are `RecostConfig.projectId`, intentionally unchanged.

- [ ] **Step 7: Run lint to confirm types are sound**

Run: `npm run lint`
Expected: clean. (Lint runs `tsc --noEmit`; if any test still references `summary.projectId` or passes `projectId` to `AggregatorConfig`/`WindowSummary`, this fails with a clear error pointing at the spot.)

- [ ] **Step 8: Run the contract test alone to confirm it now passes**

Run: `npm run test -- tests/contract.test.ts`
Expected: **PASS** for all contract tests including the two from Task 4 (`has exactly the documented top-level fields` and `does not include projectId in the body`).

- [ ] **Step 9: Run the full test suite**

Run: `npm run test`
Expected: **230/230 vitest** + **7/7 dist** = 237/237 total. (228 baseline + 1 ms+Z regex from Task 3 + 1 no-projectId-substring from Task 4.)

- [ ] **Step 10: Run the build to confirm dual ESM + CJS + DTS still emit cleanly**

Run: `npm run build`
Expected: clean output in `dist/esm/`, `dist/cjs/`, `dist/types/`.

Spot-check the type declaration:

```bash
grep -n "projectId" dist/types/core/types.d.ts
```

Expected: only the `RecostConfig.projectId` field remains (with its surrounding JSDoc). No `WindowSummary.projectId`.

- [ ] **Step 11: Commit production change + test fixes together**

```bash
git add src/core/types.ts src/core/aggregator.ts src/init.ts \
        tests/contract.test.ts tests/aggregator.test.ts \
        tests/init.test.ts tests/transport.test.ts
git commit -m "feat: drop redundant projectId from WindowSummary body (#17)

URL path is the source of truth for projectId. The cloud API already
extracts it from \`POST /projects/:id/telemetry\` and ignores the body
field. Removing it from the wire payload eliminates the silent-mismatch
risk if a future API change started trusting the body field.

RecostConfig.projectId is unchanged (still required for cloud mode,
still drives the URL path via Transport)."
```

---

## Task 6: README check

**Files:**
- Modify: `README.md` (only if it documents the body shape today)

The `WindowSummary` field set is an internal wire detail. README likely documents `RecostConfig` fields and high-level behavior, not the JSON body shape. Verify before adding any text.

- [ ] **Step 1: Check whether README documents the body shape**

Run: `grep -n -i "windowSummary\|projectId.*body\|body.*projectId" README.md`

If **no matches**: README does not document the body shape. **Skip the rest of this task** (no commit needed).

If matches exist: a body-shape table or example references `projectId`. Update those references to reflect the new shape (the field is gone) and re-run lint/build/tests. Otherwise nothing to do.

- [ ] **Step 2: If README required changes, commit them**

Only run if Step 1 found and updated content:

```bash
git add README.md
git commit -m "docs(readme): reflect WindowSummary body no longer carries projectId (#17)"
```

---

## Task 7: File cross-SDK follow-up issues

**Files:** none (GitHub-side only)

Per the brainstorming decision, two issues land on this PR's open: one for `recost-dev/middleware-python` (mirror the Node changes), one for `recost-dev/api` (defensive validator). Both reference the Node PR for design context.

- [ ] **Step 1: File the Python mirror issue**

```bash
gh issue create --repo recost-dev/middleware-python \
  --title "Wire-format cleanup: drop project_id from body, normalize timestamps to ms+Z" \
  --body "$(cat <<'EOF'
Mirror the Node-side changes from recost-dev/middleware-node#17 and recost-dev/middleware-node#20 in the Python SDK.

## Why

Both SDKs serialize \`WindowSummary\` (Python: dict equivalent) onto the wire. After the Node PR, Node no longer emits \`projectId\` in the body and pins the timestamp wire format to ISO 8601 ms-precision UTC \`Z\`. Python should match so any cross-SDK analysis on the API side sees a single stable shape.

## Tasks

1. Drop \`project_id\` from the dict that \`_aggregator.py\` produces on flush. The transport already has it for the URL path; the body field is dead weight (the API ignores it).
2. Normalize timestamps. Replace \`datetime.now(timezone.utc).isoformat()\` (microsecond precision, \`+00:00\` suffix) with a helper:

   \`\`\`python
   def _iso_now() -> str:
       return datetime.now(timezone.utc).isoformat(timespec=\"milliseconds\").replace(\"+00:00\", \"Z\")
   \`\`\`

   Call this from every site that currently produces a \`WindowSummary\` timestamp.
3. Add a \`tests/test_contract.py\` assertion mirroring the Node side: \`window_start\` / \`window_end\` match \`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\$\`, and the serialized payload does not contain \`project_id\`.

## Reference

Node-side spec / discussion lives in the PR for #17 + #20 (URL pending).

Closes the cross-SDK parity item in the wire-format-cleanup wave.
EOF
)"
```

- [ ] **Step 2: File the API defensive-validator issue**

```bash
gh issue create --repo recost-dev/api \
  --title "Add server-side validator: reject when body.projectId differs from URL param" \
  --body "$(cat <<'EOF'
Defensive backstop. After recost-dev/middleware-node#17 (and the Python mirror), neither current SDK emits \`projectId\` in the telemetry POST body. The body field has always been ignored by \`POST /projects/:id/telemetry\` — the URL path is the source of truth.

## Why this is still worth doing

A hand-rolled client, an older SDK release still in the wild, or a future regression could send \`body.projectId\` ≠ URL param. Today the API silently uses the URL value and drops the body field. That risks silently routing data to the wrong project for misconfigured clients.

## Tasks

1. In the \`POST /projects/:id/telemetry\` route handler, after parsing the body: if the parsed payload includes a \`projectId\` field AND that value does not equal the URL param, return \`400 Bad Request\` with a clear error message naming both values.
2. If \`body.projectId\` matches the URL param, accept the request normally (back-compat for older SDKs that still send the matching value).
3. Add a route test covering both branches.

## Reference

Original recommendation in recost-dev/middleware-node#17 ("Fix recommendation" section, fallback path).
EOF
)"
```

- [ ] **Step 3: Capture the issue URLs for the PR body in Task 8**

The two `gh issue create` commands print the new issue URLs. Note them — they go into the Task 8 PR body.

---

## Task 8: Final verification + push + PR

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: **230/230 vitest** + **7/7 dist** = 237/237 total green.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean dual ESM + CJS + DTS output in `dist/`.

- [ ] **Step 4: Manual diff review**

Run: `git log --oneline main..HEAD` and `git diff main..HEAD --stat`.

Expected commits in order:

1. `feat(time): add isoNow() helper documenting the cross-SDK wire format (#20)`
2. `refactor(aggregator,interceptor): route timestamps through isoNow() (#20)`
3. `test(contract): assert windowStart/windowEnd match locked ms+Z wire format (#20)`
4. `feat: drop redundant projectId from WindowSummary body (#17)` (Task 5 single commit — production + test fixes together)
5. *(optional)* `docs(readme): reflect WindowSummary body no longer carries projectId (#17)` — only if Task 6 found content to update

Files touched (without optional README): `src/core/time.ts` (new), `src/core/aggregator.ts`, `src/core/interceptor.ts`, `src/core/types.ts`, `src/init.ts`, `tests/contract.test.ts`, `tests/aggregator.test.ts`, `tests/init.test.ts`, `tests/transport.test.ts`.

- [ ] **Step 5: Manual sanity check on a serialized payload**

Run a tiny scratch script (one-off, do not commit):

```bash
node --input-type=module -e '
import { Aggregator } from "./dist/esm/core/aggregator.js";
const a = new Aggregator({ environment: "scratch", sdkVersion: "0.1.0" });
a.ingest({
  timestamp: "2026-05-14T12:00:00.000Z",
  method: "POST", url: "https://api.openai.com/v1/chat/completions",
  host: "api.openai.com", path: "/v1/chat/completions",
  statusCode: 200, latencyMs: 100, requestBytes: 0, responseBytes: 0,
  provider: "openai", endpointCategory: "chat_completions", error: false,
}, 0);
const s = a.flush();
console.log(JSON.stringify(s, null, 2));
console.log("---");
console.log("projectId in payload?", JSON.stringify(s).includes("projectId"));
console.log("windowStart format ok?", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s.windowStart));
console.log("windowEnd format ok?", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s.windowEnd));
'
```

Expected:
- `projectId in payload? false`
- `windowStart format ok? true`
- `windowEnd format ok? true`

- [ ] **Step 6: Push branch and open PR**

```bash
git push -u origin feat/17-20-wire-format-cleanup
gh pr create --title "feat: wire-format cleanup — drop body projectId, lock timestamp format (#17, #20)" --body "$(cat <<'EOF'
## Summary
- Drops the redundant \`projectId\` field from the \`WindowSummary\` body. The URL path \`POST /projects/:id/telemetry\` remains the source of truth; the API has always ignored the body field. \`RecostConfig.projectId\` is unchanged.
- Locks the timestamp wire format to ISO 8601 millisecond precision with UTC \`Z\` suffix (\`2026-05-14T12:00:00.000Z\`). Adds \`src/core/time.ts\` with an \`isoNow()\` helper documenting the contract; aggregator + interceptor route through it.
- Tightens \`tests/contract.test.ts\` with two new regression guards: a strict ms+Z regex on both timestamps, and a \`JSON.stringify\` substring check that the body never carries \`projectId\`.

Closes #17. Closes #20.

Wave 2 of the issue-waves roadmap (\`docs/superpowers/roadmap-2026-05-13-issue-waves.md\`).

## Cross-SDK follow-ups
- recost-dev/middleware-python: <PASTE PYTHON ISSUE URL FROM TASK 7>
- recost-dev/api: <PASTE API ISSUE URL FROM TASK 7>

## Breaking changes (TypeScript-level)
- \`WindowSummary.projectId\` is removed. TypeScript consumers reading \`summary.projectId\` will get a compile error pointing them here. Per #17, the only known consumer is the ReCost API, which never read the body field.
- \`AggregatorConfig.projectId\` is removed. The \`Aggregator\` constructor no longer accepts the option.

## Test plan
- [ ] \`npm run test\` — 237/237 green (228 baseline + 1 ms+Z regex + 1 no-projectId-substring)
- [ ] \`npm run lint\` — clean
- [ ] \`npm run build\` — clean dual ESM + CJS + DTS
- [ ] Manual scratch-script verification (see Task 8 Step 5): serialized payload contains no \`projectId\`; both timestamps match the locked format
EOF
)"
```

Replace the two `<PASTE ... URL FROM TASK 7>` placeholders with the URLs printed by Task 7.

- [ ] **Step 7: Update the roadmap status**

After the PR merges, update `docs/superpowers/roadmap-2026-05-13-issue-waves.md` Wave 2 status from `pending` to `done` and add a `**Merged PR:** <url>` line under the Wave 2 header. (Same pattern as Wave 1.)

---

## Self-Review

**Spec coverage:**

| Spec section item | Task |
|---|---|
| Drop `projectId` from `WindowSummary` body (#17) | Task 5 |
| Lock timestamp wire format to ms+Z (#20, contract assertion) | Task 3 |
| Single `isoNow()` helper with contract comment (#20) | Task 1 |
| Aggregator + interceptor route through helper (#20) | Task 2 |
| JSDoc on `windowStart` / `windowEnd` (#20, "comment is load-bearing") | Task 5, Step 1 |
| Drop `AggregatorConfig.projectId` (#17, internal cleanup) | Task 5, Step 2 |
| Stop passing `projectId` to `Aggregator` from `init.ts` (#17) | Task 5, Step 3 |
| Contract test top-level keys updated (#17) | Task 4, Step 1 |
| Contract test no-projectId-substring assertion (#17) | Task 4, Step 2 |
| Mechanical fixes in `aggregator.test.ts` (#17, downstream) | Task 5, Step 4 |
| Mechanical fixes in `init.test.ts` (#17, downstream) | Task 5, Step 5 |
| Mechanical fixes in `transport.test.ts` (#17, downstream) | Task 5, Step 6 |
| README check (#17, may be no-op) | Task 6 |
| Cross-SDK Python follow-up issue (#17 + #20) | Task 7, Step 1 |
| API defensive-validator follow-up issue (#17) | Task 7, Step 2 |
| PR open + roadmap update | Task 8 |

**Placeholder scan:** no TBDs, no "implement later", no abstract "add validation" steps. Every code change shows the before/after; the two PR-body URL placeholders (`<PASTE ... URL FROM TASK 7>`) are intentional — the issue URLs are unknown until Task 7 runs.

**Type consistency:**
- `isoNow()` — defined in Task 1 with signature `() => string`. Imported and called in Task 2 from both `aggregator.ts` and `interceptor.ts` with no arguments. JSDoc reference appears in Task 5's `WindowSummary` JSDoc.
- `WindowSummary` post-Task-5 keys: `environment`, `sdkLanguage`, `sdkVersion`, `windowStart`, `windowEnd`, `metrics` — six keys. Same six listed in Task 4's updated `EXPECTED_TOP_LEVEL_KEYS` constant (after `.sort()`).
- The wire-format regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` is referenced identically in Task 3 (contract-test addition) and Task 8 (manual scratch-script verification).
- `AggregatorConfig` post-Task-5: three optional fields (`environment?`, `sdkVersion?`, `maxBuckets?`). All `new Aggregator({ ... })` call sites in Tasks 5 (Step 4 sub-cases a, b) pass only fields from this set.
- The discriminator rename `projectId` → `environment` in `tests/transport.test.ts` (Task 5, Step 6c) is consistent across all 13 spots — both the value-set side (`makeSummary({ ... })`) and the read side (`received.projectId` / `parsed.projectId` / `.map(... projectId)`).

**Test count consistency:**
- Baseline: 228 vitest + 7 dist = 235 (post-PR-#33).
- After Task 3: 229 vitest + 7 dist = 236.
- After Task 4: still 229 vitest (the `EXPECTED_TOP_LEVEL_KEYS` change modifies an existing test; the substring assertion is +1 — but that +1 lands here, making it 230 vitest after Task 4 in the editor, even though it's red. After Task 5 turns it green, the count holds at 230 vitest + 7 dist = 237.)
- Final: **230 vitest + 7 dist = 237 total**. Asserted in Task 5 Step 9 and Task 8 Step 1.

**Branching reminder:** The plan assumes the work happens on a fresh worktree off latest `main`, branch `feat/17-20-wire-format-cleanup`. The executor should provision the worktree via `superpowers:using-git-worktrees` before starting Task 1.
