/**
 * Post-build smoke test — regression for consolidated audit issue #1.
 *
 * `package.json` exposes the SDK to consumers via three discovery surfaces:
 *
 *   1. `exports["."].require` → `./dist/cjs/index.cjs`   (modern + CJS)
 *   2. `exports["."].import`  → `./dist/esm/index.js`    (modern + ESM)
 *   3. `main` / `types`                                  (legacy resolvers)
 *
 * tsup writes exactly those files. Before this fix, `main` and `types`
 * pointed at `dist/index.js` and `dist/index.d.ts` — files that are never
 * emitted — and any legacy resolver (TypeScript `moduleResolution: "node"`,
 * older bundlers, some monorepo tools) would fail to load the package.
 *
 * This test runs against the actual `dist/` output. The npm `test:dist`
 * script builds first, so by the time this file executes `dist/` exists.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Resolve from the repo root regardless of where vitest is invoked.
const REPO_ROOT = resolve(__dirname, "..");
const CJS_PATH = resolve(REPO_ROOT, "dist/cjs/index.cjs");
const ESM_PATH = resolve(REPO_ROOT, "dist/esm/index.js");
const DTS_PATH = resolve(REPO_ROOT, "dist/types/index.d.ts");

// The symbols `src/index.ts` re-exports. If you add or remove a public
// export there, update this list — the test will fail until you do.
const EXPECTED_VALUE_EXPORTS = [
  "init",
  "ProviderRegistry",
  "BUILTIN_PROVIDERS",
  "install",
  "uninstall",
  "isInstalled",
  "Aggregator",
  "MAX_BUCKETS",
  "Transport",
  "createExpressMiddleware",
  "createFastifyPlugin",
] as const;

describe("published package paths (audit issue #1)", () => {
  it("emits dist/cjs/index.cjs", () => {
    expect(existsSync(CJS_PATH)).toBe(true);
  });

  it("emits dist/esm/index.js", () => {
    expect(existsSync(ESM_PATH)).toBe(true);
  });

  it("emits dist/types/index.d.ts", () => {
    expect(existsSync(DTS_PATH)).toBe(true);
  });

  it("package.json `main` points at a file that exists", async () => {
    const pkg = (await import("../package.json")) as unknown as {
      default: { main: string; types: string };
    };
    const mainPath = resolve(REPO_ROOT, pkg.default.main);
    expect(
      existsSync(mainPath),
      `package.json "main" = ${pkg.default.main} but ${mainPath} does not exist`,
    ).toBe(true);
  });

  it("package.json `types` points at a file that exists", async () => {
    const pkg = (await import("../package.json")) as unknown as {
      default: { main: string; types: string };
    };
    const typesPath = resolve(REPO_ROOT, pkg.default.types);
    expect(
      existsSync(typesPath),
      `package.json "types" = ${pkg.default.types} but ${typesPath} does not exist`,
    ).toBe(true);
  });

  it("CJS bundle loads via require() and exports the public surface", () => {
    const requireFromHere = createRequire(import.meta.url);
    const mod = requireFromHere(CJS_PATH) as Record<string, unknown>;
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(mod[name], `CJS bundle missing export ${name}`).toBeDefined();
    }
  });

  it("ESM bundle loads via dynamic import() and exports the public surface", async () => {
    // file:// URL is required for dynamic import of an absolute path on Windows.
    const url = new URL(`file://${ESM_PATH.replace(/\\/g, "/")}`);
    const mod = (await import(url.href)) as Record<string, unknown>;
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(mod[name], `ESM bundle missing export ${name}`).toBeDefined();
    }
  });
});
