/**
 * Aggregator — fans out a single request to multiple providers and merges results.
 * Logic TBD. Scaffold only.
 */

import type { AggregatorResult, EcoRequest } from "./types.js";

export class Aggregator {
  // TODO: implement fan-out, timeout, partial-failure handling
  async aggregate<T = unknown>(
    _providerIds: string[],
    _req: EcoRequest,
  ): Promise<AggregatorResult<T>[]> {
    return [];
  }
}
