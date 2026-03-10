/**
 * Scaffold smoke test — verifies the package exports resolve without errors.
 * Replace with real tests as logic is implemented.
 */

import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  InterceptorChain,
  Aggregator,
  HttpTransport,
} from "../src/index.js";

describe("@ecoapi/node scaffold", () => {
  it("ProviderRegistry instantiates", () => {
    const registry = new ProviderRegistry();
    expect(registry).toBeDefined();
    expect(registry.list()).toEqual([]);
  });

  it("InterceptorChain instantiates", () => {
    const chain = new InterceptorChain();
    expect(chain).toBeDefined();
  });

  it("Aggregator instantiates", () => {
    const agg = new Aggregator();
    expect(agg).toBeDefined();
  });

  it("HttpTransport instantiates", () => {
    const transport = new HttpTransport();
    expect(transport).toBeDefined();
  });
});
