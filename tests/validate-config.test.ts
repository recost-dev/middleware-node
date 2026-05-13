/**
 * Tests for src/core/validate-config.ts.
 *
 * validateConfig is a pure function — no servers, no patching, no async.
 * Every assertion runs in microseconds.
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/core/validate-config.js";

describe("validateConfig — apiKey format", () => {
  it("accepts apiKey starting with 'rc-'", () => {
    expect(() => validateConfig({ apiKey: "rc-abc123", projectId: "proj_1" })).not.toThrow();
  });

  it("rejects apiKey not starting with 'rc-'", () => {
    expect(() => validateConfig({ apiKey: "sk-bad", projectId: "proj_1" })).toThrow(
      /apiKey must be a string beginning with "rc-"/,
    );
  });

  it("rejects the literal string 'undefined' as apiKey (common env-misread footgun)", () => {
    expect(() => validateConfig({ apiKey: "undefined", projectId: "proj_1" })).toThrow(
      /apiKey must be a string beginning with "rc-"/,
    );
  });

  it("rejects empty-string apiKey", () => {
    expect(() => validateConfig({ apiKey: "", projectId: "proj_1" })).toThrow(
      /apiKey must be a string beginning with "rc-"/,
    );
  });

  it("includes a redacted prefix in the error message so users can identify which key failed", () => {
    expect(() => validateConfig({ apiKey: "sk-abcdefghij", projectId: "proj_1" })).toThrow(
      /sk-abcde/,
    );
  });

  it("does not echo the full apiKey in the error message (avoid leaking secrets to logs)", () => {
    const fullKey = "sk-DO_NOT_LOG_THIS_FULL_KEY_PLEASE";
    try {
      validateConfig({ apiKey: fullKey, projectId: "proj_1" });
    } catch (err) {
      expect((err as Error).message).not.toContain("DO_NOT_LOG_THIS_FULL_KEY_PLEASE");
      return;
    }
    throw new Error("expected validateConfig to throw");
  });

  it("undefined apiKey is fine — local mode, no validation needed", () => {
    expect(() => validateConfig({})).not.toThrow();
  });
});
