/**
 * Express adapter for @recost-dev/node.
 * Calls init() with the provided config and returns the middleware plus the
 * SDK handle so callers can dispose the SDK after mounting (tests, hot-reload,
 * graceful shutdown).
 * Express itself is a peer dependency — types are kept loose so this file
 * compiles without requiring @types/express in the SDK's own package.json.
 */

import type { RecostConfig } from "../core/types.js";
import { init, type RecostHandle } from "../init.js";

type NextFn = (err?: unknown) => void;
type Middleware = (req: unknown, res: unknown, next: NextFn) => void;

/** Result of `createExpressMiddleware` — the middleware to mount plus the SDK handle. */
export interface ExpressAdapter {
  /** The Express middleware. Mount it with `app.use(...)`. */
  middleware: Middleware;
  /** The SDK handle returned by `init()`. Use `recost.dispose()` to tear down. */
  recost: RecostHandle;
}

/**
 * Returns an Express middleware that initializes ReCost telemetry, paired with
 * the SDK handle so callers can dispose the SDK after mount.
 *
 * ```ts
 * const { middleware, recost } = createExpressMiddleware({ apiKey: process.env.RECOST_KEY });
 * app.use(middleware);
 * // later, on shutdown:
 * await recost.dispose();
 * ```
 */
export function createExpressMiddleware(config?: RecostConfig): ExpressAdapter {
  const recost = init(config);
  const middleware: Middleware = (_req, _res, next) => next();
  return { middleware, recost };
}
