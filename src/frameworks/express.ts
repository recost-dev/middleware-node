/**
 * Express adapter for @recost/node.
 * Calls init() with the provided config and returns a no-op middleware.
 * Express itself is a peer dependency — types are kept loose so this file
 * compiles without requiring @types/express in the SDK's own package.json.
 */

import type { RecostConfig } from "../core/types.js";
import { init } from "../init.js";

type NextFn = (err?: unknown) => void;
type Middleware = (req: unknown, res: unknown, next: NextFn) => void;

/**
 * Returns an Express middleware that initializes ReCost telemetry on first use.
 * Mount it early in the middleware chain:
 *
 * ```ts
 * app.use(createExpressMiddleware({ apiKey: process.env.RECOST_KEY }));
 * ```
 */
export function createExpressMiddleware(config?: RecostConfig): Middleware {
  init(config);
  return (_req, _res, next) => next();
}
