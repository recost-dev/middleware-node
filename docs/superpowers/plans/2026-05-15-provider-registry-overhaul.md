# Provider Registry Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three correctness issues in the provider registry / aggregator and document Twilio pricing source-of-truth. (a) Custom catch-all rules silently shadow built-in path-specific rules ([#13.1](https://github.com/recost-dev/middleware-node/issues/13)); (b) catch-all matches return the raw pathname as `endpointCategory`, leaking high-cardinality account-SID-style segments into aggregator buckets ([#13.2](https://github.com/recost-dev/middleware-node/issues/13)); (c) `wouldOverflow` is an early-flush *hint* but the async gap between hint and flush lets events past the cap ([#13.3](https://github.com/recost-dev/middleware-node/issues/13)); (d) Twilio price constants have no source-of-truth comments ([#21](https://github.com/recost-dev/middleware-node/issues/21)). One bundled PR.

**Architecture:**

- **#13.1 (priority):** `ProviderRegistry` constructor merges custom + built-in rules, tags each by source, then stably sorts by specificity descending. Specificity tiers: (1) has `pathPrefix` > no `pathPrefix`; (2) longer `pathPrefix` > shorter; (3) exact host > `*.` wildcard host; (4) custom > built-in (tie-breaker only). The result: a custom catch-all on `api.openai.com` no longer shadows the built-in `/v1/chat/completions` rule, but a custom rule with equal specificity still overrides its built-in twin.
- **#13.2 (cardinality):** `match()` returns `"other"` for the `endpointCategory` when a rule lacks both `pathPrefix` and `endpointCategory`. The Twilio post-match refiner (`refineTwilio`) continues to produce `"sms"` / `"voice_calls"` for known paths; its fallback also changes from raw pathname to `"other"`.
- **#13.3 (soft cap):** `Aggregator.ingest()` checks `_buckets.size >= _maxBuckets && key is new` synchronously at the top of the method; if true, redirects into a `(provider, "_overflow", method)` bucket so counts / latencies / bytes / cost still accumulate but `endpointCategory` cardinality is bounded. A new `overflowCount` counter exposes how many events were redirected since the last flush. `wouldOverflow()` remains as the early-flush hint in `init.ts` — useful but no longer load-bearing for correctness.
- **#21 (Twilio docs):** Three short comments above the Twilio constants citing source URLs and `reviewed 2026-05-15`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, tsup dual ESM + CJS build, Node.js ≥ 18.

---

## File Structure

- **Modify** `src/core/provider-registry.ts`:
  - Add a private `_specificityScore` / `compareRules` helper (module-scope function).
  - `ProviderRegistry` constructor: tag each rule with `custom: boolean`, sort the merged list with `compareRules`, store untagged sorted rules in `_rules`.
  - `match()`: when `rule.endpointCategory === undefined` and no provider-specific refiner applies, return `"other"` instead of `pathname`.
  - `refineTwilio()`: fallback return value changes from `endpointCategory: pathname` to `endpointCategory: "other"`.
  - Three doc comments above the Twilio cost constants citing source URLs and review date.
  - Class JSDoc and the `customProviders` parameter doc updated to describe the new priority semantics ("merged and sorted by specificity, custom wins on tie").

- **Modify** `src/core/aggregator.ts`:
  - Inline soft-cap redirect inside `ingest()` (before the `let bucket = …` block): if at cap and key would create a new bucket, set `endpoint = "_overflow"`, recompute the key, increment `_overflowCount`.
  - Add `private _overflowCount = 0;`, reset to 0 in `flush()`, expose via `get overflowCount(): number`.
  - JSDoc comment on `wouldOverflow()` clarifies its hint role.

- **Modify** `tests/provider-registry.test.ts`:
  - **Update 5 existing tests** that asserted the old contract: line 51–56 (OpenAI catch-all), 67–72 (Anthropic catch-all), 126–135 (Twilio catch-all), 259–273 (custom-priority same host+path), 316–324 (custom rule via list()).
  - **Add 5 new tests** under a new `describe("rule ordering & priority")` block: custom catch-all no longer shadows built-in specifics; custom specific overrides built-in equivalent (equal specificity); exact host beats wildcard host; sort is deterministic across repeated constructions; ordering inside `list()` reflects the new tiers.
  - **Add 3 new tests** under `describe("catch-all endpointCategory")`: Twilio unrecognized path → `"other"`; AWS wildcard catch-all → `"other"`; Twilio `/Messages.json` → `"sms"` (regression guard).

- **Modify** `tests/aggregator.test.ts`:
  - **Add 4 new tests** under a new `describe("Aggregator — soft cap (ingest-time)")` block: at cap, new key redirected to `_overflow` bucket; at cap, existing bucket still ingests normally; multiple over-cap events accumulate counts / latencies / bytes / cost into the per-provider `_overflow` bucket; `overflowCount` getter reports redirects and resets on flush.

- **Modify** `README.md`:
  - Lines 93 + 165–179 (`customProviders` field doc and `### Custom providers` snippet): clarify the new semantics — "merged and sorted by specificity; custom rules win on tie".
  - Line 225 (`Registry with custom rules taking priority` comment in code sample): nuance the comment to "...taking priority on equal specificity".
  - Add a short new subsection `### Custom provider priority` after `### Custom providers` (≤ 8 lines) explaining the specificity sort with a one-line example.

- **Modify** `docs/superpowers/roadmap-2026-05-13-issue-waves.md`:
  - Flip Wave 3 status from `in-progress` to `done`; add `**Merged PR:** https://github.com/recost-dev/middleware-node/pull/35`.
  - Flip Wave 4 status from `pending` to `in-progress`; add a `**Plan:**` link to this file.

- **Create** `docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md` — this file.

**Test count delta:** baseline **241/241** vitest (234 unit + 7 `tests/dist.test.ts` smoke tests on the built bundle). Wave 4 adds 5 + 3 + 4 = **12 new tests** and modifies 5 existing tests in-place (no net change from updates). Final: **253/253** vitest.

`src/core/types.ts`, `src/init.ts`, `src/index.ts`, `package.json`, `tsup.config.ts`, and all other files are untouched.

---

## Task 1: Set up Wave 4 worktree, commit the roadmap + plan

**Files:**
- Create worktree: `.claude/worktrees/wave-4-provider-registry/`
- Modify: `docs/superpowers/roadmap-2026-05-13-issue-waves.md`
- Create: `docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md`

Mirrors the Wave 3 handoff convention: first commit bundles the prior wave's roadmap-done update + this wave's plan doc.

- [ ] **Step 1: Verify no stale Wave 4 worktree exists**

Run from any directory:

```bash
git -C /home/andresl/Projects/recost/middleware-node worktree list
```

Expected: the list does NOT already contain `.claude/worktrees/wave-4-provider-registry`. If it does, the worktree was already created — skip step 2 and go to step 3.

- [ ] **Step 2: Create the Wave 4 worktree off the latest `origin/main`**

Run from `/home/andresl/Projects/recost/middleware-node` (the main repo root, NOT a worktree):

```bash
cd /home/andresl/Projects/recost/middleware-node
git fetch origin main
git worktree add -b feat/13-21-provider-registry-overhaul .claude/worktrees/wave-4-provider-registry origin/main
cd .claude/worktrees/wave-4-provider-registry
```

Expected output ends with: `Preparing worktree (new branch 'feat/13-21-provider-registry-overhaul')` and `HEAD is now at c2ad485 Merge pull request #35 ...`.

All subsequent steps in this plan run from `.claude/worktrees/wave-4-provider-registry/` unless stated otherwise.

- [ ] **Step 3: Copy this plan file into the new worktree**

From `.claude/worktrees/wave-4-provider-registry/`, run:

```bash
cp /home/andresl/Projects/recost/middleware-node/docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md
```

Expected: file exists at `docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md` inside the new worktree.

- [ ] **Step 4: Update the roadmap doc — flip Wave 3 to done, Wave 4 to in-progress**

Open `docs/superpowers/roadmap-2026-05-13-issue-waves.md`.

Find the Wave 3 header block (currently around lines 58–62):

```markdown
## Wave 3 — Interceptor surgical fixes

**Status:** in-progress

**Plan:** `plans/2026-05-15-interceptor-surgical-fixes.md`
```

Replace with:

```markdown
## Wave 3 — Interceptor surgical fixes

**Status:** done

**Merged PR:** https://github.com/recost-dev/middleware-node/pull/35

**Plan:** `plans/2026-05-15-interceptor-surgical-fixes.md`
```

Find the Wave 4 header block (currently around lines 79–83):

```markdown
## Wave 4 — Provider registry overhaul

**Status:** pending
```

Replace with:

```markdown
## Wave 4 — Provider registry overhaul

**Status:** in-progress

**Plan:** `plans/2026-05-15-provider-registry-overhaul.md`
```

- [ ] **Step 5: Verify tests still pass on the fresh branch**

Run:

```bash
npm install
npm run lint
npm run build
npm run test
```

Expected: lint clean. Vitest reports **241/241** (the total includes the 7 `dist.test.ts` smoke tests, which only pass after `npm run build` populates `dist/` — hence the explicit build step above).

If `npm install` modifies `package-lock.json`, that is an environment artifact unrelated to this work — `git checkout -- package-lock.json` before staging.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/roadmap-2026-05-13-issue-waves.md docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md
git commit -m "docs: mark wave 3 done; add wave 4 provider registry overhaul plan (#13, #21)"
```

Verify: `git log --oneline -1` shows the new commit on top of `c2ad485`.

---

## Task 2: Sort rules by specificity, custom wins on tie (#13.1)

**Files:**
- Modify: `src/core/provider-registry.ts:130-185` (constructor + add private comparator)
- Modify: `src/core/provider-registry.ts:1-7` (class JSDoc)
- Modify: `tests/provider-registry.test.ts:259-273` (update existing test)
- Modify: `tests/provider-registry.test.ts:316-324` (update existing test)
- Modify: `tests/provider-registry.test.ts` (add new `describe("rule ordering & priority")` block)

TDD bundle: update broken-by-design existing tests AND add new tests first, run, confirm failures, implement, run, confirm passing, commit.

- [ ] **Step 1: Update the two existing tests that codify the old behavior**

Open `tests/provider-registry.test.ts`. Find the test `"custom provider takes priority over built-in for same host+path"` (lines 259–273):

```typescript
  it("custom provider takes priority over built-in for same host+path", () => {
    const registry = new ProviderRegistry([
      {
        hostPattern: "api.openai.com",
        pathPrefix: "/v1/chat",
        provider: "custom-openai",
        endpointCategory: "custom_chat",
        costPerRequestCents: 99,
      },
    ]);
    const result = registry.match("https://api.openai.com/v1/chat/completions");
    expect(result?.provider).toBe("custom-openai");
    expect(result?.endpointCategory).toBe("custom_chat");
    expect(result?.costPerRequestCents).toBe(99);
  });
```

Replace with (custom now has equal specificity — same `pathPrefix` length as the built-in — so it wins on the tie-breaker):

```typescript
  it("custom provider with equal specificity overrides built-in (tie-breaker)", () => {
    const registry = new ProviderRegistry([
      {
        hostPattern: "api.openai.com",
        pathPrefix: "/v1/chat/completions", // same prefix length as built-in
        provider: "custom-openai",
        endpointCategory: "custom_chat",
        costPerRequestCents: 99,
      },
    ]);
    const result = registry.match("https://api.openai.com/v1/chat/completions");
    expect(result?.provider).toBe("custom-openai");
    expect(result?.endpointCategory).toBe("custom_chat");
    expect(result?.costPerRequestCents).toBe(99);
  });
```

Then find `"custom rule via list() appears before built-in rules"` (lines 316–324):

```typescript
  it("custom rule via list() appears before built-in rules", () => {
    const registry = new ProviderRegistry([
      { hostPattern: "api.acme.com", provider: "acme" },
    ]);
    const rules = registry.list();
    expect(rules[0]?.provider).toBe("acme");
    // Built-in rules follow after
    expect(rules.some((r) => r.provider === "openai")).toBe(true);
  });
```

Replace with:

```typescript
  it("custom rule is present in list() and ordered by specificity, not insertion", () => {
    const registry = new ProviderRegistry([
      // A custom catch-all (no pathPrefix) — under the new sort it lands
      // among other no-prefix rules, NOT at index 0.
      { hostPattern: "api.acme.com", provider: "acme" },
    ]);
    const rules = registry.list();
    // Custom rule is in the list
    expect(rules.some((r) => r.provider === "acme")).toBe(true);
    // Built-ins are still present
    expect(rules.some((r) => r.provider === "openai")).toBe(true);
    // The first rule has a pathPrefix (more specific than any catch-all)
    expect(rules[0]?.pathPrefix).toBeDefined();
  });
```

- [ ] **Step 2: Add a new `describe("rule ordering & priority")` block**

In the same file, find the closing `});` of `describe("custom providers", ...)` (around line 325). Immediately after it, insert this new block:

```typescript
// ---------------------------------------------------------------------------

describe("rule ordering & priority", () => {
  it("custom catch-all does NOT shadow built-in path-specific rules", () => {
    // Before this fix: a custom rule with hostPattern "api.openai.com" and no
    // pathPrefix landed at index 0 and won every OpenAI URL, silently disabling
    // chat_completions, embeddings, image_generation, etc.
    // After this fix: the built-in /v1/chat/completions rule is more specific
    // (has pathPrefix) and wins. The custom catch-all only matches OpenAI URLs
    // that no built-in path-specific rule covers.
    const registry = new ProviderRegistry([
      { hostPattern: "api.openai.com", provider: "openai-custom", costPerRequestCents: 99 },
    ]);

    // Built-in specifics still win
    expect(registry.match("https://api.openai.com/v1/chat/completions")?.provider)
      .toBe("openai");
    expect(registry.match("https://api.openai.com/v1/embeddings")?.provider)
      .toBe("openai");

    // Custom catch-all wins ONLY for paths no built-in covers
    expect(registry.match("https://api.openai.com/v1/something-new")?.provider)
      .toBe("openai-custom");
  });

  it("custom specific rule beats built-in catch-all on the same host", () => {
    // No built-in rule for /v1/embeddings/special; built-in OpenAI catch-all
    // would match. Custom with longer pathPrefix wins by specificity.
    const registry = new ProviderRegistry([
      {
        hostPattern: "api.openai.com",
        pathPrefix: "/v1/embeddings/special",
        provider: "custom-embed-special",
        endpointCategory: "special_embed",
      },
    ]);
    const result = registry.match("https://api.openai.com/v1/embeddings/special/foo");
    expect(result?.provider).toBe("custom-embed-special");
    expect(result?.endpointCategory).toBe("special_embed");
  });

  it("exact host beats wildcard host on tie", () => {
    // Custom rule with exact host vs built-in wildcard "*.amazonaws.com" —
    // both match s3.us-east-1.amazonaws.com, but the exact-host rule wins.
    const registry = new ProviderRegistry([
      { hostPattern: "s3.us-east-1.amazonaws.com", provider: "my-s3", costPerRequestCents: 0.01 },
    ]);
    const result = registry.match("https://s3.us-east-1.amazonaws.com/bucket/key");
    expect(result?.provider).toBe("my-s3");
    expect(result?.costPerRequestCents).toBe(0.01);

    // A different AWS subdomain still falls through to the built-in wildcard
    expect(registry.match("https://lambda.us-east-1.amazonaws.com/x")?.provider).toBe("aws");
  });

  it("sort is deterministic across repeated constructions", () => {
    const customs = [
      { hostPattern: "api.example.com", pathPrefix: "/v1/a", provider: "ex-a" },
      { hostPattern: "api.example.com", pathPrefix: "/v1/b", provider: "ex-b" },
    ];
    const a = new ProviderRegistry(customs).list().map((r) => r.provider);
    const b = new ProviderRegistry(customs).list().map((r) => r.provider);
    expect(a).toEqual(b);
  });

  it("list() order: rules with pathPrefix come before rules without", () => {
    const rules = new ProviderRegistry().list();
    const firstPrefixless = rules.findIndex((r) => r.pathPrefix === undefined);
    if (firstPrefixless === -1) return; // all have prefixes — vacuously true
    // No rule with pathPrefix can appear after a rule without one
    for (let i = firstPrefixless + 1; i < rules.length; i++) {
      expect(rules[i]!.pathPrefix).toBeUndefined();
    }
  });
});
```

- [ ] **Step 3: Run the new + updated tests and confirm they fail**

Run:

```bash
npm run test -- --run tests/provider-registry.test.ts -t "priority|catch-all|tie|specificity|ordering|sort"
```

Expected: at minimum these tests fail:
- `"custom provider with equal specificity overrides built-in (tie-breaker)"` — passes coincidentally (custom is index 0 in pre-fix code), don't gate on this one
- `"custom catch-all does NOT shadow built-in path-specific rules"` — fails on the first `expect(registry.match("https://api.openai.com/v1/chat/completions")?.provider).toBe("openai")` with `expected "openai-custom" to be "openai"`
- `"exact host beats wildcard host on tie"` — fails on `expect(result?.provider).toBe("my-s3")` with `expected "aws" to be "my-s3"` (the wildcard built-in matches first because it's prepended to BUILTIN_PROVIDERS but custom is currently prepended further — actually pre-fix the custom-prepend rule means custom does win here. This test passes coincidentally pre-fix; it's a regression guard for post-fix. Do not gate on this test for failure.)
- `"list() order: rules with pathPrefix come before rules without"` — fails because built-in array order is not specificity-sorted globally (OpenAI specifics come first, but Twilio catch-all comes BEFORE SendGrid specifics).

The load-bearing failure is `"custom catch-all does NOT shadow built-in path-specific rules"` — do not proceed until you've seen it fail with `expected "openai-custom" to be "openai"`.

- [ ] **Step 4: Implement the specificity sort in the registry**

Open `src/core/provider-registry.ts`. Find the class JSDoc (lines 1–7):

```typescript
/**
 * ProviderRegistry — matches intercepted request URLs to known API providers.
 *
 * Rules are checked in order; the first match wins. Custom providers are
 * prepended at construction time so they always take priority over built-ins.
 */
```

Replace with:

```typescript
/**
 * ProviderRegistry — matches intercepted request URLs to known API providers.
 *
 * Rules are checked in order; the first match wins. At construction time,
 * custom and built-in rules are merged and sorted by specificity (descending):
 *   1. Rules with `pathPrefix` come before rules without.
 *   2. Within those, longer `pathPrefix` beats shorter (more specific).
 *   3. Within those, exact host beats `*.` wildcard host.
 *   4. On equal specificity, custom rules beat built-in rules.
 *
 * This means a custom catch-all (no `pathPrefix`) for `api.openai.com` does NOT
 * shadow the built-in `/v1/chat/completions` rule — the built-in is more
 * specific. A custom rule with `pathPrefix: "/v1/chat/completions"` on the
 * same host DOES override the built-in (equal specificity → custom wins).
 */
```

Then find the `ProviderRegistry` class (line 130 onward):

```typescript
/** Maps intercepted request URLs to provider metadata using an ordered rule list. */
export class ProviderRegistry {
  private readonly _rules: ProviderDef[];

  /**
   * @param customProviders - Optional extra rules prepended before built-ins,
   *   giving them higher matching priority.
   */
  constructor(customProviders: ProviderDef[] = []) {
    this._rules = [...customProviders, ...BUILTIN_PROVIDERS];
  }
```

Replace with:

```typescript
/** Compares two tagged rules by specificity descending (more specific first). */
function compareRules(
  a: { rule: ProviderDef; custom: boolean },
  b: { rule: ProviderDef; custom: boolean },
): number {
  // Tier 1: rules with pathPrefix come before rules without
  const aHasPath = a.rule.pathPrefix !== undefined ? 1 : 0;
  const bHasPath = b.rule.pathPrefix !== undefined ? 1 : 0;
  if (aHasPath !== bHasPath) return bHasPath - aHasPath;

  // Tier 2: longer pathPrefix wins (more specific)
  const aLen = a.rule.pathPrefix?.length ?? 0;
  const bLen = b.rule.pathPrefix?.length ?? 0;
  if (aLen !== bLen) return bLen - aLen;

  // Tier 3: exact host beats *. wildcard host
  const aExact = a.rule.hostPattern.startsWith("*.") ? 0 : 1;
  const bExact = b.rule.hostPattern.startsWith("*.") ? 0 : 1;
  if (aExact !== bExact) return bExact - aExact;

  // Tier 4: custom rules win on tie
  if (a.custom !== b.custom) return a.custom ? -1 : 1;

  return 0;
}

/** Maps intercepted request URLs to provider metadata using a priority-sorted rule list. */
export class ProviderRegistry {
  private readonly _rules: ProviderDef[];

  /**
   * @param customProviders - Optional extra rules. Merged with built-ins and
   *   sorted by specificity (longer `pathPrefix` first, exact host before
   *   wildcard, custom-wins-on-tie). See the class JSDoc for the full rule.
   */
  constructor(customProviders: ProviderDef[] = []) {
    const tagged: { rule: ProviderDef; custom: boolean }[] = [
      ...customProviders.map((rule) => ({ rule, custom: true })),
      ...BUILTIN_PROVIDERS.map((rule) => ({ rule, custom: false })),
    ];
    tagged.sort(compareRules);
    this._rules = tagged.map((t) => t.rule);
  }
```

The rest of the class body (`match()`, `list()`) is unchanged in this task — Task 3 will edit `match()` separately.

- [ ] **Step 5: Run the priority tests and confirm they pass**

Run:

```bash
npm run test -- --run tests/provider-registry.test.ts -t "priority|catch-all|tie|specificity|ordering|sort"
```

Expected: all targeted tests pass, including `"custom catch-all does NOT shadow built-in path-specific rules"` (the load-bearing one).

- [ ] **Step 6: Run the full provider-registry suite**

Run:

```bash
npm run test -- --run tests/provider-registry.test.ts
```

Expected: every test in this file passes. (Two existing tests that asserted the old contract were updated in Step 1 to match the new contract.)

- [ ] **Step 7: Run lint and the full test suite**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **246/246** (baseline 241 + 5 new in `provider-registry.test.ts`; the 2 in-place edits are net 0).

- [ ] **Step 8: Commit**

```bash
git add src/core/provider-registry.ts tests/provider-registry.test.ts
git commit -m "refactor(registry): sort rules by specificity, custom wins on tie (#13)"
```

---

## Task 3: Catch-all matches yield `"other"`, not raw pathname (#13.2)

**Files:**
- Modify: `src/core/provider-registry.ts:117-127` (`refineTwilio` fallback)
- Modify: `src/core/provider-registry.ts:148-179` (`match` — catch-all branch)
- Modify: `tests/provider-registry.test.ts:51-56` (OpenAI catch-all test)
- Modify: `tests/provider-registry.test.ts:67-72` (Anthropic catch-all test)
- Modify: `tests/provider-registry.test.ts:126-135` (Twilio catch-all test)
- Modify: `tests/provider-registry.test.ts` (add new `describe("catch-all endpointCategory")` block)

TDD bundle.

- [ ] **Step 1: Update three existing tests that asserted raw-pathname behavior**

Open `tests/provider-registry.test.ts`.

Find `"matches OpenAI catch-all for unknown path — uses raw pathname as category"` (around line 51):

```typescript
  it("matches OpenAI catch-all for unknown path — uses raw pathname as category", () => {
    const result = registry.match("https://api.openai.com/v1/some/future/endpoint");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("/v1/some/future/endpoint");
    expect(result?.costPerRequestCents).toBe(1.0);
  });
```

Replace with:

```typescript
  it("matches OpenAI catch-all for unknown path — endpointCategory is 'other'", () => {
    const result = registry.match("https://api.openai.com/v1/some/future/endpoint");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("other");
    expect(result?.costPerRequestCents).toBe(1.0);
  });
```

Find `"matches Anthropic catch-all for unknown path"` (around line 67):

```typescript
  it("matches Anthropic catch-all for unknown path", () => {
    const result = registry.match("https://api.anthropic.com/v1/complete");
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("/v1/complete");
  });
```

Replace with:

```typescript
  it("matches Anthropic catch-all for unknown path — endpointCategory is 'other'", () => {
    const result = registry.match("https://api.anthropic.com/v1/complete");
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("other");
  });
```

Find `"matches Twilio catch-all for unrecognized paths — uses raw pathname"` (around line 126):

```typescript
  it("matches Twilio catch-all for unrecognized paths — uses raw pathname", () => {
    const result = registry.match(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Usage.json",
    );
    expect(result?.provider).toBe("twilio");
    expect(result?.costPerRequestCents).toBe(0.5);
    // endpoint should be the raw pathname
    expect(typeof result?.endpointCategory).toBe("string");
    expect(result?.endpointCategory).toContain("/");
  });
```

Replace with:

```typescript
  it("matches Twilio catch-all for unrecognized paths — endpointCategory is 'other'", () => {
    const result = registry.match(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Usage.json",
    );
    expect(result?.provider).toBe("twilio");
    expect(result?.costPerRequestCents).toBe(0.5);
    expect(result?.endpointCategory).toBe("other");
  });
```

- [ ] **Step 2: Add a new `describe("catch-all endpointCategory")` block**

Find the closing `});` of `describe("rule ordering & priority", ...)` (added in Task 2). Immediately after it, insert this new block:

```typescript
// ---------------------------------------------------------------------------

describe("catch-all endpointCategory", () => {
  const registry = new ProviderRegistry();

  it("Twilio /Messages.json still refines to 'sms' (regression guard)", () => {
    // Twilio's refineTwilio() still produces named categories for known paths;
    // only the unrecognized-path fallback changed from raw pathname to 'other'.
    const result = registry.match(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
    );
    expect(result?.endpointCategory).toBe("sms");
    expect(result?.costPerRequestCents).toBe(0.79);
  });

  it("AWS wildcard catch-all → endpointCategory is 'other'", () => {
    const result = registry.match(
      "https://s3.us-east-1.amazonaws.com/some-bucket/path/to/object",
    );
    expect(result?.provider).toBe("aws");
    expect(result?.endpointCategory).toBe("other");
  });

  it("GCP wildcard catch-all → endpointCategory is 'other'", () => {
    const result = registry.match(
      "https://storage.googleapis.com/bucket-xyz/object-key-with-uuid-12345",
    );
    expect(result?.provider).toBe("gcp");
    expect(result?.endpointCategory).toBe("other");
  });
});
```

- [ ] **Step 3: Run the new + updated tests and confirm they fail**

Run:

```bash
npm run test -- --run tests/provider-registry.test.ts -t "other|catch-all|regression"
```

Expected: the three updated tests (OpenAI, Anthropic, Twilio) and the two new AWS/GCP tests fail with `expected "/some/path" to be "other"`-style errors. The Twilio `/Messages.json` regression test passes already (no behavior change for refined paths).

- [ ] **Step 4: Implement the `match()` catch-all change and the Twilio refiner fallback**

Open `src/core/provider-registry.ts`. Find `refineTwilio` (lines 117–127):

```typescript
/** Refines category and cost for Twilio after a host-level match. */
function refineTwilio(pathname: string): Pick<MatchResult, "endpointCategory" | "costPerRequestCents"> {
  if (pathname.includes("/Messages")) {
    return { endpointCategory: "sms",         costPerRequestCents: 0.79 };
  }
  if (pathname.includes("/Calls")) {
    return { endpointCategory: "voice_calls", costPerRequestCents: 1.3  };
  }
  return { endpointCategory: pathname,        costPerRequestCents: 0.5  };
}
```

Replace with:

```typescript
/** Refines category and cost for Twilio after a host-level match. */
function refineTwilio(pathname: string): Pick<MatchResult, "endpointCategory" | "costPerRequestCents"> {
  if (pathname.includes("/Messages")) {
    return { endpointCategory: "sms",         costPerRequestCents: 0.79 };
  }
  if (pathname.includes("/Calls")) {
    return { endpointCategory: "voice_calls", costPerRequestCents: 1.3  };
  }
  // Unrecognized Twilio path: fall back to "other" rather than the raw
  // pathname (which would include account SIDs and explode cardinality
  // downstream in the aggregator).
  return { endpointCategory: "other",         costPerRequestCents: 0.5  };
}
```

Then find the catch-all branch inside `match()` (around lines 160–175):

```typescript
    for (const rule of this._rules) {
      if (!hostMatches(rule.hostPattern, hostname)) continue;
      if (rule.pathPrefix !== undefined && !pathname.startsWith(rule.pathPrefix)) continue;

      // Host (and optional path) matched — build the result
      let endpointCategory = rule.endpointCategory ?? pathname;
      let costPerRequestCents = rule.costPerRequestCents ?? 0;

      // Post-match refinement for providers with dynamic path structures
      if (rule.provider === "twilio" && rule.endpointCategory === undefined) {
        const refined = refineTwilio(pathname);
        endpointCategory = refined.endpointCategory;
        costPerRequestCents = refined.costPerRequestCents;
      }

      return { provider: rule.provider, endpointCategory, costPerRequestCents };
    }
```

Replace with:

```typescript
    for (const rule of this._rules) {
      if (!hostMatches(rule.hostPattern, hostname)) continue;
      if (rule.pathPrefix !== undefined && !pathname.startsWith(rule.pathPrefix)) continue;

      // Host (and optional path) matched — build the result.
      // When the rule has no explicit endpointCategory and no provider-specific
      // refiner applies, fall back to the literal "other". Returning the raw
      // pathname here leaks account-SID-style segments into downstream buckets.
      let endpointCategory = rule.endpointCategory ?? "other";
      let costPerRequestCents = rule.costPerRequestCents ?? 0;

      // Post-match refinement for providers with dynamic path structures
      if (rule.provider === "twilio" && rule.endpointCategory === undefined) {
        const refined = refineTwilio(pathname);
        endpointCategory = refined.endpointCategory;
        costPerRequestCents = refined.costPerRequestCents;
      }

      return { provider: rule.provider, endpointCategory, costPerRequestCents };
    }
```

- [ ] **Step 5: Run the catch-all tests and confirm they pass**

Run:

```bash
npm run test -- --run tests/provider-registry.test.ts -t "other|catch-all"
```

Expected: every test passes, including the three updated existing tests.

- [ ] **Step 6: Run the full provider-registry suite**

Run:

```bash
npm run test -- --run tests/provider-registry.test.ts
```

Expected: every test in this file passes.

- [ ] **Step 7: Run lint and the full test suite**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **249/249** (previous 246 + 3 new; 3 in-place edits net 0).

- [ ] **Step 8: Commit**

```bash
git add src/core/provider-registry.ts tests/provider-registry.test.ts
git commit -m "fix(registry): catch-all matches yield 'other' endpoint, not raw path (#13)"
```

---

## Task 4: Enforce soft bucket cap inside `Aggregator.ingest()` (#13.3)

**Files:**
- Modify: `src/core/aggregator.ts:67-204` (add `_overflowCount`, soft-cap branch in `ingest()`, getter, `flush()` reset, `wouldOverflow` JSDoc)
- Modify: `tests/aggregator.test.ts` (add new `describe("Aggregator — soft cap (ingest-time)")` block)

TDD bundle. No changes needed in `init.ts` — `wouldOverflow()` stays as the early-flush hint; the cap is now enforced synchronously inside `ingest()` so the async gap between the hint and `flush()` is closed.

- [ ] **Step 1: Add a new `describe("Aggregator — soft cap (ingest-time)")` block to the aggregator test file**

Open `tests/aggregator.test.ts`. Find the closing `});` of `describe("Aggregator — bucket overflow protection", ...)` (around line 360). Immediately after it, insert this new block:

```typescript
describe("Aggregator — soft cap (ingest-time)", () => {
  it("at cap, an event with a new key is redirected to a per-provider _overflow bucket", () => {
    const agg = new Aggregator({ maxBuckets: 3 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "c" }));
    expect(agg.bucketCount).toBe(3);

    // This is event #4 with a new (provider, endpoint, method) triplet — at cap.
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "d", latencyMs: 999, requestBytes: 7, responseBytes: 11 }), 1.5);

    // A new _overflow bucket is created — bucketCount goes to 4. The cap is
    // soft: the redirect bucket is allowed to exceed the limit by exactly 1
    // per (provider, method) — counts stay bounded, attribution preserved.
    expect(agg.bucketCount).toBe(4);
    expect(agg.overflowCount).toBe(1);

    const summary = agg.flush()!;
    const overflow = summary.metrics.find((m) => m.endpoint === "_overflow" && m.provider === "p");
    expect(overflow).toBeDefined();
    expect(overflow!.requestCount).toBe(1);
    expect(overflow!.totalLatencyMs).toBe(999);
    expect(overflow!.totalRequestBytes).toBe(7);
    expect(overflow!.totalResponseBytes).toBe(11);
    expect(overflow!.estimatedCostCents).toBeCloseTo(1.5);
  });

  it("at cap, an event matching an EXISTING bucket key still ingests normally", () => {
    const agg = new Aggregator({ maxBuckets: 3 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "c" }));
    expect(agg.bucketCount).toBe(3);

    // Same triplet as the first event — no new bucket needed, no overflow.
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    expect(agg.bucketCount).toBe(3);
    expect(agg.overflowCount).toBe(0);

    const summary = agg.flush()!;
    const bucketA = summary.metrics.find((m) => m.endpoint === "a")!;
    expect(bucketA.requestCount).toBe(2);
  });

  it("multiple over-cap events accumulate into one _overflow bucket per (provider, method)", () => {
    const agg = new Aggregator({ maxBuckets: 2 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a", method: "GET" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b", method: "GET" }));

    // 5 over-cap events, all with the same (provider, method) but different
    // endpoints — they all collapse into a single (p, _overflow, GET) bucket.
    for (let i = 0; i < 5; i++) {
      agg.ingest(makeEvent({ provider: "p", endpointCategory: `new-${i}`, method: "GET", latencyMs: 100 }), 0.5);
    }

    expect(agg.bucketCount).toBe(3); // 2 original + 1 overflow
    expect(agg.overflowCount).toBe(5);

    const summary = agg.flush()!;
    const overflow = summary.metrics.find((m) => m.endpoint === "_overflow")!;
    expect(overflow.requestCount).toBe(5);
    expect(overflow.totalLatencyMs).toBe(500);
    expect(overflow.estimatedCostCents).toBeCloseTo(2.5);
  });

  it("overflowCount is exposed via getter and resets to 0 on flush", () => {
    const agg = new Aggregator({ maxBuckets: 1 });
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "a" }));
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "b" })); // overflow #1
    agg.ingest(makeEvent({ provider: "p", endpointCategory: "c" })); // overflow #2 (same _overflow bucket, but still counted)
    expect(agg.overflowCount).toBe(2);

    agg.flush();
    expect(agg.overflowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
npm run test -- --run tests/aggregator.test.ts -t "soft cap"
```

Expected: all four tests fail. The first fails on `expect(agg.overflowCount).toBe(1)` with `TypeError: agg.overflowCount is undefined` (getter doesn't exist yet). The second fails on `expect(agg.bucketCount).toBe(3)` — pre-fix, ingesting at cap with a new key creates a fourth real bucket (no redirect), bucketCount goes to 4.

Wait — pre-fix: the second test sets cap=3, ingests 3 distinct triplets (bucketCount=3), then re-ingests the first triplet. `ingest()` calls `this._buckets.get(key)` with an existing key — finds the bucket, increments. bucketCount stays 3, no overflow. So the second test PASSES pre-fix (overflowCount-related assertion will fail because the getter doesn't exist). The test files runs every assertion until one fails; the `expect(agg.overflowCount).toBe(0)` line throws because the getter is undefined.

Practically: all four tests fail with `agg.overflowCount` errors. Do not proceed until that error appears.

- [ ] **Step 3: Implement the soft-cap redirect inside `ingest()`, add `_overflowCount`**

Open `src/core/aggregator.ts`. Find the field declarations (lines 67–75):

```typescript
export class Aggregator {
  private readonly _environment: string;
  private readonly _sdkVersion: string;
  private readonly _maxBuckets: number;

  private _buckets = new Map<string, Bucket>();
  private _windowStart: string | null = null;
  private _size = 0;
```

Replace with:

```typescript
export class Aggregator {
  private readonly _environment: string;
  private readonly _sdkVersion: string;
  private readonly _maxBuckets: number;

  private _buckets = new Map<string, Bucket>();
  private _windowStart: string | null = null;
  private _size = 0;
  private _overflowCount = 0;
```

Then find `wouldOverflow()` (lines 92–96) and update its JSDoc only — behavior is unchanged:

```typescript
  /**
   * True if ingesting this event would allocate a new bucket AND the current
   * window is already at maxBuckets capacity. Callers should flush first.
   */
  wouldOverflow(event: RawEvent): boolean {
    if (this._buckets.size < this._maxBuckets) return false;
    return !this._buckets.has(this._keyFor(event));
  }
```

Replace with:

```typescript
  /**
   * Early-flush hint: true if ingesting this event would allocate a new bucket
   * AND the current window is already at `maxBuckets` capacity. Callers may
   * trigger an early flush to preserve the window before adding more events.
   *
   * Note: this is a hint, not a guarantee. Even without a flush, `ingest()`
   * itself synchronously enforces the cap by redirecting new keys into a
   * per-provider `_overflow` bucket — so cardinality stays bounded even when
   * the caller misses the hint or hits an async gap before flushing.
   */
  wouldOverflow(event: RawEvent): boolean {
    if (this._buckets.size < this._maxBuckets) return false;
    return !this._buckets.has(this._keyFor(event));
  }
```

Then find `ingest()` (lines 109–142):

```typescript
  ingest(event: RawEvent, costCents = 0): void {
    if (this._windowStart === null) {
      this._windowStart = event.timestamp;
    }

    const provider = event.provider ?? "unknown";
    const endpoint = event.endpointCategory ?? event.path;
    const key = this._keyFor(event);

    let bucket = this._buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        provider,
        endpoint,
        method: event.method,
        requestCount: 0,
        errorCount: 0,
        latencies: [],
        totalRequestBytes: 0,
        totalResponseBytes: 0,
        estimatedCostCents: 0,
      };
      this._buckets.set(key, bucket);
    }

    bucket.requestCount += 1;
    if (event.error) bucket.errorCount += 1;
    bucket.latencies.push(event.latencyMs);
    bucket.totalRequestBytes += event.requestBytes;
    bucket.totalResponseBytes += event.responseBytes;
    bucket.estimatedCostCents += costCents;

    this._size += 1;
  }
```

Replace with:

```typescript
  ingest(event: RawEvent, costCents = 0): void {
    if (this._windowStart === null) {
      this._windowStart = event.timestamp;
    }

    const provider = event.provider ?? "unknown";
    let endpoint = event.endpointCategory ?? event.path;
    let key = this._keyFor(event);

    // Soft cap enforced synchronously: if we're at the bucket limit AND this
    // event would create a new bucket, redirect into a per-provider _overflow
    // bucket. Counts / latencies / bytes / cost are still accumulated — only
    // endpoint cardinality is bounded. `wouldOverflow()` remains the early-
    // flush hint, but the async gap between hint and flush in init.ts is now
    // closed here.
    if (this._buckets.size >= this._maxBuckets && !this._buckets.has(key)) {
      endpoint = "_overflow";
      key = `${provider}::_overflow::${event.method}`;
      this._overflowCount += 1;
    }

    let bucket = this._buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        provider,
        endpoint,
        method: event.method,
        requestCount: 0,
        errorCount: 0,
        latencies: [],
        totalRequestBytes: 0,
        totalResponseBytes: 0,
        estimatedCostCents: 0,
      };
      this._buckets.set(key, bucket);
    }

    bucket.requestCount += 1;
    if (event.error) bucket.errorCount += 1;
    bucket.latencies.push(event.latencyMs);
    bucket.totalRequestBytes += event.requestBytes;
    bucket.totalResponseBytes += event.responseBytes;
    bucket.estimatedCostCents += costCents;

    this._size += 1;
  }
```

Then find `flush()` near the end (lines 175–179):

```typescript
    // Reset
    this._buckets = new Map();
    this._windowStart = null;
    this._size = 0;
```

Replace with:

```typescript
    // Reset
    this._buckets = new Map();
    this._windowStart = null;
    this._size = 0;
    this._overflowCount = 0;
```

Finally, add the public getter. Find the existing getters at the end of the class (lines 191–203):

```typescript
  /** Total events ingested since the last flush. */
  get size(): number {
    return this._size;
  }

  /** Number of unique provider + endpoint + method groups in the current window. */
  get bucketCount(): number {
    return this._buckets.size;
  }

  /** Configured maximum buckets per window. */
  get maxBuckets(): number {
    return this._maxBuckets;
  }
}
```

Replace with:

```typescript
  /** Total events ingested since the last flush. */
  get size(): number {
    return this._size;
  }

  /** Number of unique provider + endpoint + method groups in the current window. */
  get bucketCount(): number {
    return this._buckets.size;
  }

  /** Configured maximum buckets per window. */
  get maxBuckets(): number {
    return this._maxBuckets;
  }

  /**
   * Number of events redirected into a `_overflow` bucket since the last flush
   * because the bucket cap was reached. Resets to 0 on every `flush()`.
   */
  get overflowCount(): number {
    return this._overflowCount;
  }
}
```

- [ ] **Step 4: Run the soft-cap tests and confirm they pass**

Run:

```bash
npm run test -- --run tests/aggregator.test.ts -t "soft cap"
```

Expected: all four new tests pass.

- [ ] **Step 5: Run the full aggregator suite**

Run:

```bash
npm run test -- --run tests/aggregator.test.ts
```

Expected: every test in this file passes — including the existing `wouldOverflow` tests, which still verify the hint behavior unchanged.

- [ ] **Step 6: Run lint and the full test suite**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **253/253** (previous 249 + 4 new).

- [ ] **Step 7: Commit**

```bash
git add src/core/aggregator.ts tests/aggregator.test.ts
git commit -m "fix(aggregator): enforce soft bucket cap via _overflow bucket (#13)"
```

---

## Task 5: Twilio pricing source-of-truth comments (#21)

**Files:**
- Modify: `src/core/provider-registry.ts:56-58` (Twilio rule block)
- Modify: `src/core/provider-registry.ts:117-130` (`refineTwilio` constants)

No test changes — these are documentation-only edits. The constants themselves don't change.

- [ ] **Step 1: Add source-of-truth comments to the Twilio rule in `BUILTIN_PROVIDERS`**

Open `src/core/provider-registry.ts`. Find the Twilio block (around lines 56–58):

```typescript
  // ── Twilio ────────────────────────────────────────────────────────────────
  // Path structure varies by account SID; categorization happens post-match in match().
  { hostPattern: "api.twilio.com", provider: "twilio", costPerRequestCents: 0.5 },
```

Replace with:

```typescript
  // ── Twilio ────────────────────────────────────────────────────────────────
  // Path structure varies by account SID; categorization happens post-match
  // in match() via refineTwilio().
  // Default (unrefined) cost: 0.5¢ placeholder for endpoints we don't
  // explicitly recognize. Source: rough median across Twilio's per-product
  // pricing pages, reviewed 2026-05-15.
  { hostPattern: "api.twilio.com", provider: "twilio", costPerRequestCents: 0.5 },
```

- [ ] **Step 2: Add source-of-truth comments to the constants in `refineTwilio`**

In the same file, find `refineTwilio` (lines 117–131, post-Task-3 — the function that now returns `"other"` for the fallback):

```typescript
/** Refines category and cost for Twilio after a host-level match. */
function refineTwilio(pathname: string): Pick<MatchResult, "endpointCategory" | "costPerRequestCents"> {
  if (pathname.includes("/Messages")) {
    return { endpointCategory: "sms",         costPerRequestCents: 0.79 };
  }
  if (pathname.includes("/Calls")) {
    return { endpointCategory: "voice_calls", costPerRequestCents: 1.3  };
  }
  // Unrecognized Twilio path: fall back to "other" rather than the raw
  // pathname (which would include account SIDs and explode cardinality
  // downstream in the aggregator).
  return { endpointCategory: "other",         costPerRequestCents: 0.5  };
}
```

Replace with:

```typescript
/**
 * Refines category and cost for Twilio after a host-level match.
 *
 * Pricing constants below are per-request US-outbound averages. They are
 * rough estimates for relative cost comparison only — actual Twilio pricing
 * varies by destination country, sender type, and volume discounts.
 */
function refineTwilio(pathname: string): Pick<MatchResult, "endpointCategory" | "costPerRequestCents"> {
  if (pathname.includes("/Messages")) {
    // Twilio SMS: $0.0079/msg US outbound.
    // Source: https://www.twilio.com/sms/pricing/us — reviewed 2026-05-15.
    return { endpointCategory: "sms",         costPerRequestCents: 0.79 };
  }
  if (pathname.includes("/Calls")) {
    // Twilio Voice: $0.013/min US outbound (per-minute, treated as per-request
    // for a typical short call).
    // Source: https://www.twilio.com/voice/pricing/us — reviewed 2026-05-15.
    return { endpointCategory: "voice_calls", costPerRequestCents: 1.3  };
  }
  // Unrecognized Twilio path: fall back to "other" rather than the raw
  // pathname (which would include account SIDs and explode cardinality
  // downstream in the aggregator).
  return { endpointCategory: "other",         costPerRequestCents: 0.5  };
}
```

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **253/253** (unchanged — comments only).

- [ ] **Step 4: Commit**

```bash
git add src/core/provider-registry.ts
git commit -m "docs(registry): cite Twilio pricing source-of-truth (#21)"
```

---

## Task 6: README updates for new registry semantics

**Files:**
- Modify: `README.md:93` (customProviders field doc)
- Modify: `README.md:165-179` (Custom providers section)
- Modify: `README.md:225` (code-comment inside Using the registry directly)
- Modify: `README.md` (add a new `### Custom provider priority` subsection)

No test changes.

- [ ] **Step 1: Update the `customProviders` row in the config table**

Open `README.md`. Find line 93:

```markdown
| `customProviders` | `ProviderDef[]` | `[]` | Extra provider rules merged with higher priority than built-ins. |
```

Replace with:

```markdown
| `customProviders` | `ProviderDef[]` | `[]` | Extra provider rules merged with built-ins; sorted by specificity (longer `pathPrefix` wins; on tie, custom beats built-in). |
```

- [ ] **Step 2: Add a `### Custom provider priority` subsection**

In the same file, find the `### Custom providers` section ending at line 179 (closing ``` of the code block, just before `### Cleanup / teardown`):

```markdown
### Custom providers

```ts
init({
  customProviders: [
    {
      hostPattern: "api.internal.acme.com",
      pathPrefix: "/payments",
      provider: "acme-payments",
      endpointCategory: "charge",
      costPerRequestCents: 0.5,
    },
  ],
});
```

### Cleanup / teardown
```

Replace with:

```markdown
### Custom providers

```ts
init({
  customProviders: [
    {
      hostPattern: "api.internal.acme.com",
      pathPrefix: "/payments",
      provider: "acme-payments",
      endpointCategory: "charge",
      costPerRequestCents: 0.5,
    },
  ],
});
```

### Custom provider priority

Custom and built-in rules are merged and sorted by specificity at `ProviderRegistry` construction time. The sort is:

1. Rules with a `pathPrefix` come before rules without.
2. Longer `pathPrefix` wins (more specific).
3. Exact host beats `*.` wildcard host.
4. On equal specificity, custom rules win.

So a custom catch-all (`{ hostPattern: "api.openai.com", provider: "openai-mock" }` with no `pathPrefix`) does NOT shadow built-in path-specific OpenAI rules — those are more specific. A custom rule with `pathPrefix: "/v1/chat/completions"` on the same host DOES override the built-in (equal specificity → custom wins).

### Cleanup / teardown
```

- [ ] **Step 3: Update the inline code-comment in the `Using the registry directly` section**

Find line 225:

```markdown
// Registry with custom rules taking priority
const custom = new ProviderRegistry([
```

Replace with:

```markdown
// Registry with custom rules — priority by specificity, custom wins on tie
const custom = new ProviderRegistry([
```

- [ ] **Step 4: Run the full test suite (sanity check)**

Run:

```bash
npm run lint && npm run test
```

Expected: lint clean. Vitest reports **253/253**.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): describe specificity-based registry priority (#13)"
```

---

## Task 7: Final verification and open the PR

**Files:** none modified. Verification + PR creation only.

- [ ] **Step 1: Run the full pre-flight gate**

Run:

```bash
npm run lint && npm run build && npm run test
```

Expected: lint clean, build emits both `dist/esm/` and `dist/cjs/`, vitest reports **253/253** (246 vitest unit + 7 dist smoke; `npm run test` re-runs the dist smoke tests as `test:dist` after build).

- [ ] **Step 2: Verify the branch state**

Run:

```bash
git log --oneline origin/main..HEAD
```

Expected output (six commits, newest first):

```
<sha> docs(readme): describe specificity-based registry priority (#13)
<sha> docs(registry): cite Twilio pricing source-of-truth (#21)
<sha> fix(aggregator): enforce soft bucket cap via _overflow bucket (#13)
<sha> fix(registry): catch-all matches yield 'other' endpoint, not raw path (#13)
<sha> refactor(registry): sort rules by specificity, custom wins on tie (#13)
<sha> docs: mark wave 3 done; add wave 4 provider registry overhaul plan (#13, #21)
```

Run:

```bash
git status
```

Expected: `nothing to commit, working tree clean` (or only the `package-lock.json` artifact from `npm install`, which should NOT be committed).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/13-21-provider-registry-overhaul
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create \
  --base main \
  --title "fix(registry,aggregator): specificity-sorted priority + soft-cap enforcement + Twilio price docs (#13, #21)" \
  --body "$(cat <<'EOF'
## Summary

Wave 4 — three correctness fixes in the provider registry / aggregator plus Twilio pricing source-of-truth comments, bundled as one PR. Also marks Wave 3 done with its merged PR link.

- **#13.1 — Custom catch-all shadowed built-ins.** A user-provided rule like `{ hostPattern: "api.openai.com", provider: "openai-custom" }` (no `pathPrefix`) was prepended unconditionally and silently disabled every built-in OpenAI path-specific rule. Fix: at construction, merge custom + built-in rules and stably sort by specificity descending — rules with `pathPrefix` before those without; longer `pathPrefix` first; exact host before `*.` wildcard; custom-wins-on-tie. The custom catch-all now only matches paths no built-in covers.
- **#13.2 — Catch-all leaked high-cardinality paths.** `match()` returned the raw pathname as `endpointCategory` for host-only catch-alls, so every Twilio account SID became a unique aggregator bucket. Fix: catch-all returns the literal `"other"`. Twilio's refiner still produces `"sms"` / `"voice_calls"` for known paths; its fallback also changed from raw pathname to `"other"`.
- **#13.3 — Soft cap bypassed by async gap.** `init.ts` calls `aggregator.wouldOverflow(event)` and then `flushAndSend()` (async) before falling through to `aggregator.ingest(event)`. Events ingested between the hint and the resolved flush still landed in the full map. Fix: `Aggregator.ingest()` now synchronously redirects over-cap new-key events into a per-provider `_overflow` bucket. Counts / latencies / bytes / cost are still accumulated; only `endpointCategory` cardinality is bounded. New `overflowCount` getter reports redirects, resets on flush. `wouldOverflow()` keeps its early-flush hint role.
- **#21 — Twilio pricing comments.** Added source URLs and `reviewed 2026-05-15` notes above the three Twilio cost constants (0.79¢ SMS, 1.3¢ voice, 0.5¢ default).

No public API additions beyond `Aggregator.overflowCount`. No changes to `init.ts` or any other file.

## Roadmap

First commit also flips Wave 3 to `done` with merged PR link (#35) and Wave 4 to `in-progress` with this plan — leftover docs maintenance bundled per the Wave 3 → Wave 4 handoff convention.

## Test plan

- [x] `npm run lint` clean
- [x] `npm run build` emits ESM + CJS
- [x] `npm run test` — **253/253 vitest** (baseline 241 + 12 new; includes the 7 dist smoke tests; `test:dist` re-runs those 7 separately after build)
  - 5 new tests for #13.1 priority — custom catch-all no longer shadows; custom specific overrides built-in; exact host beats wildcard; deterministic sort; pathPrefix-first ordering invariant in `list()`
  - 3 new tests for #13.2 catch-all — AWS / GCP wildcard catch-all → `"other"`; Twilio `/Messages.json` → `"sms"` regression guard
  - 4 new tests for #13.3 soft cap — at cap, new key → `_overflow`; existing bucket at cap still ingests; multiple over-cap events accumulate in one per-provider overflow bucket; `overflowCount` exposure + reset
  - 5 existing tests updated in-place to reflect the new contract (3 catch-all tests now expect `"other"`; 2 custom-priority tests reframed to test equal-specificity / list-ordering invariants)

## Plan

See `docs/superpowers/plans/2026-05-15-provider-registry-overhaul.md`.

Closes #13, closes #21.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. Record it.

- [ ] **Step 5: Hand off**

Once this PR is merged, the next session updates `docs/superpowers/roadmap-2026-05-13-issue-waves.md` to flip Wave 4 from `in-progress` to `done` and adds the merged PR link. That update lands on Wave 5's branch — same handoff convention Wave 4 just used for Wave 3.

Wave 5 is the next major piece: **#11** (multi-realm — workers, dual-package, third-party patches) and **#19** (Python sync vs Node async `dispose()` parity). Wave 5 will rewrite parts of `src/core/interceptor.ts` (which Wave 3 just touched) and `src/init.ts` — landing the registry fix first means Wave 5's bigger surgery starts on a stable contract.

---

## Self-Review Notes

**Spec coverage:**
- #13.1 (custom-vs-builtin priority) → Task 2. ✓
- #13.2 (catch-all cardinality) → Task 3. ✓
- #13.3 (soft cap bypass) → Task 4. ✓
- #21 (Twilio pricing comments) → Task 5. ✓
- README semantic update → Task 6. ✓
- Wave 3 → done roadmap update + plan landing → Task 1. ✓
- Final PR → Task 7. ✓

**Placeholder scan:** none. Every code block is concrete. Every command is exact. Every expected output is specified.

**Type consistency:**
- `ProviderRegistry` constructor signature unchanged (`customProviders?: ProviderDef[]`). Only internal implementation changes.
- `match()` and `list()` return types unchanged.
- `Aggregator.ingest()` signature unchanged. New private field `_overflowCount` and new public getter `overflowCount: number` — additive only.
- `RawEvent`, `MetricEntry`, `WindowSummary`, `ProviderDef` shapes unchanged.

**Sequencing rationale:** Task 2 (sort) lands before Task 3 (catch-all) because the sort touches the constructor and the catch-all touches `match()` — independent edits, but reviewing Task 2 first gives the reviewer the design context (specificity tiers) they'll need to evaluate Task 3's `"other"` fallback in `refineTwilio`. Task 4 (aggregator) is in a different file and could land in any position; placing it third keeps related registry edits contiguous in the git log. Task 5 (Twilio docs) and Task 6 (README) are doc-only; they land last so they describe the final shipped behavior. Task 7 is the PR.

**Why no `init.ts` change:** The original issue text suggested making `init.ts`'s `wouldOverflow` → `flushAndSend` interaction synchronous. Moving the cap inside `ingest()` is a cleaner fix: the early-flush hint stays (so windows are preserved when possible), but cap enforcement no longer depends on the caller honoring the hint or the flush settling before the next event arrives. `init.ts` is touched in Wave 5 (#11 multi-realm) so leaving it alone here reduces merge surface.
