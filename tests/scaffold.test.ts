/**
 * Scaffold smoke test — verifies the package exports resolve without errors.
 * Replace with real tests as logic is implemented.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  ProviderRegistry,
  isInstalled,
  uninstall,
  Aggregator,
  Transport,
} from "../src/index.js";

describe("@ecoapi/node scaffold", () => {
  afterEach(() => { uninstall(); });

  it("ProviderRegistry instantiates", () => {
    const registry = new ProviderRegistry();
    expect(registry).toBeDefined();
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it("interceptor reports not installed by default", () => {
    expect(isInstalled()).toBe(false);
  });

  it("Aggregator instantiates with size 0", () => {
    const agg = new Aggregator();
    expect(agg).toBeDefined();
    expect(agg.size).toBe(0);
  });

  it("Transport detects local mode when no apiKey", () => {
    const transport = new Transport({});
    expect(transport.mode).toBe("local");
  });

  it("Transport detects cloud mode when apiKey is set", () => {
    const transport = new Transport({ apiKey: "test-key" });
    expect(transport.mode).toBe("cloud");
  });
});
