/**
 * HttpTransport — default fetch-based transport implementation.
 * Logic TBD. Scaffold only.
 */

import type { EcoRequest, EcoResponse, Transport, TransportOptions } from "./types.js";

export class HttpTransport implements Transport {
  // TODO: implement fetch with retry, timeout, and error normalisation
  async send(_req: EcoRequest, _opts?: TransportOptions): Promise<EcoResponse> {
    return { status: 0 };
  }
}
