/**
 * Tests for src/frameworks/fastify.ts
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createFastifyPlugin } from "../src/frameworks/fastify.js";
import { isInstalled, uninstall } from "../src/core/interceptor.js";

afterEach(() => {
  uninstall();
});

describe("createFastifyPlugin", () => {
  it("initializes the SDK at factory-call time — interceptor is installed immediately", () => {
    createFastifyPlugin();
    expect(isInstalled()).toBe(true);
  });

  it("returns an object with `plugin` and `recost`", () => {
    const adapter = createFastifyPlugin();
    expect(typeof adapter.plugin).toBe("function");
    expect(adapter.plugin.length).toBe(3);
    expect(typeof adapter.recost).toBe("object");
    expect(typeof adapter.recost.dispose).toBe("function");
  });

  it("plugin calls done() when Fastify registers it", () => {
    const { plugin } = createFastifyPlugin();
    const done = vi.fn();
    plugin({}, {}, done);
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith();
  });

  it("passes config to init — enabled: false does not install interceptor", () => {
    const { plugin } = createFastifyPlugin({ enabled: false });
    const done = vi.fn();
    plugin({}, {}, done);
    expect(isInstalled()).toBe(false);
    expect(done).toHaveBeenCalledOnce();
  });

  it("done is called without an error argument under normal conditions", () => {
    const { plugin } = createFastifyPlugin();
    const done = vi.fn();
    plugin({}, {}, done);
    const [arg] = done.mock.calls[0]!;
    expect(arg).toBeUndefined();
  });

  it("returns the RecostHandle so callers can dispose after registration", async () => {
    const { plugin, recost } = createFastifyPlugin();
    expect(typeof plugin).toBe("function");
    expect(plugin.length).toBe(3);
    expect(typeof recost.dispose).toBe("function");

    const done = vi.fn();
    plugin({}, {}, done);
    expect(isInstalled()).toBe(true);
    expect(done).toHaveBeenCalledOnce();

    await recost.dispose();
    expect(isInstalled()).toBe(false);
  });
});
