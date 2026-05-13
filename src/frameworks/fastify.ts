/**
 * Fastify adapter for @recost-dev/node.
 * Returns a Fastify plugin function plus the SDK handle so callers can
 * dispose the SDK after registration (tests, hot-reload, graceful shutdown).
 * Fastify itself is a peer dependency — types are kept loose to avoid requiring
 * @types/fastify in the SDK's own package.json.
 */

import type { RecostConfig } from "../core/types.js";
import { init, type RecostHandle } from "../init.js";

type FastifyInstance = object;
type DoneFn = (err?: Error) => void;
type FastifyPlugin = (app: FastifyInstance, opts: RecostConfig, done: DoneFn) => void;

/** Result of `createFastifyPlugin` — the plugin to register plus the SDK handle. */
export interface FastifyAdapter {
  /** The Fastify plugin function. Pass it to `app.register(...)`. */
  plugin: FastifyPlugin;
  /** The SDK handle returned by `init()`. Use `recost.dispose()` to tear down. */
  recost: RecostHandle;
}

/**
 * Returns a Fastify plugin that initializes ReCost telemetry, paired with the
 * SDK handle so callers can dispose the SDK after registration. The SDK is
 * initialized eagerly at factory-call time (not at plugin-registration time),
 * so config arguments to `app.register(plugin, opts)` are ignored — pass them
 * to `createFastifyPlugin(config)` instead.
 *
 * ```ts
 * const { plugin, recost } = createFastifyPlugin({ apiKey: process.env.RECOST_KEY });
 * await app.register(plugin);
 * // later, on shutdown:
 * await recost.dispose();
 * ```
 */
export function createFastifyPlugin(config?: RecostConfig): FastifyAdapter {
  const recost = init(config);
  const plugin: FastifyPlugin = (_app, _opts, done) => {
    done();
  };
  return { plugin, recost };
}
