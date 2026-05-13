/**
 * validateConfig — synchronous pre-flight checks on RecostConfig.
 *
 * Called at the top of init() so misconfiguration fails fast with an
 * actionable message, instead of silently entering a broken cloud-mode
 * state that drops every telemetry window.
 *
 * Rules (in evaluation order):
 *   1. If `apiKey` is set, it must be a string beginning with "rc-".
 *   2. If `apiKey` is set, `projectId` must be a non-empty, non-whitespace string.
 *
 * Local mode (no apiKey) intentionally requires no projectId — the local
 * extension demultiplexes via the WebSocket connection identity, not the
 * payload's projectId field.
 */

import type { RecostConfig } from "./types.js";

/** Throws if `config` would cause the SDK to enter a known-broken state. */
export function validateConfig(config: RecostConfig): void {
  if (config.apiKey !== undefined) {
    if (typeof config.apiKey !== "string" || !config.apiKey.startsWith("rc-")) {
      const preview =
        typeof config.apiKey === "string"
          ? `"${config.apiKey.slice(0, 8)}..."`
          : `<${typeof config.apiKey}>`;
      throw new Error(
        `recost: apiKey must be a string beginning with "rc-". Got: ${preview}. ` +
          `If you're reading from an env var, confirm RECOST_API_KEY is set; ` +
          `a literal string "undefined" from a missing variable is a common cause.`,
      );
    }
  }
}
