/**
 * InterceptorChain — composes request/response interceptors into a pipeline.
 * Logic TBD. Scaffold only.
 */

import type { Interceptor } from "./types.js";

export class InterceptorChain {
  // TODO: build middleware pipeline (compose NextFn chain)
  private readonly _interceptors: Interceptor[] = [];

  add(_interceptor: Interceptor): this {
    // stub
    return this;
  }

  remove(_interceptor: Interceptor): this {
    // stub
    return this;
  }

  clear(): this {
    // stub
    return this;
  }
}
