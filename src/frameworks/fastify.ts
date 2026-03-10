/**
 * Fastify adapter for @ecoapi/node.
 * Registers EcoAPI telemetry as a Fastify plugin.
 * Fastify itself is a peer dependency — types are kept loose to avoid requiring
 * @types/fastify in the SDK's own package.json.
 */

import type { EcoAPIConfig } from "../core/types.js";
import { init } from "../init.js";

type FastifyInstance = object;
type DoneFn = (err?: Error) => void;

/**
 * Fastify plugin that initializes EcoAPI telemetry.
 * Register it at the root level:
 *
 * ```ts
 * await app.register(createFastifyPlugin, { apiKey: process.env.ECOAPI_KEY });
 * ```
 */
export function createFastifyPlugin(
  _app: FastifyInstance,
  opts: EcoAPIConfig,
  done: DoneFn,
): void {
  init(opts);
  done();
}
