/**
 * ProviderRegistry — central store for registered AI providers.
 * Logic TBD. Scaffold only.
 */

import type { Provider } from "./types.js";

export class ProviderRegistry {
  // TODO: implement registration, lookup, and lifecycle hooks
  private readonly _providers = new Map<string, Provider>();

  register(_provider: Provider): void {
    // stub
  }

  get(_id: string): Provider | undefined {
    return undefined;
  }

  list(): Provider[] {
    return [];
  }

  unregister(_id: string): boolean {
    return false;
  }
}
