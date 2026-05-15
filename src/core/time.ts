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
