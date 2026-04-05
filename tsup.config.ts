import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist/esm",
    target: "es2020",
    dts: false,
    sourcemap: true,
    clean: true,
  },
  {
    entry: ["src/index.ts"],
    format: ["cjs"],
    outDir: "dist/cjs",
    target: "es2020",
    dts: false,
    sourcemap: true,
  },
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist/types",
    target: "es2020",
    dts: { only: true },
  },
]);
