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
  it("initializes the SDK — interceptor is installed after registration", () => {
    createFastifyPlugin({}, {}, () => {});
    expect(isInstalled()).toBe(true);
  });

  it("calls done() after initialization", () => {
    const done = vi.fn();
    createFastifyPlugin({}, {}, done);
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith();
  });

  it("passes config to init — enabled: false does not install interceptor", () => {
    const done = vi.fn();
    createFastifyPlugin({}, { enabled: false }, done);
    expect(isInstalled()).toBe(false);
    expect(done).toHaveBeenCalledOnce();
  });

  it("done is called without an error argument under normal conditions", () => {
    const done = vi.fn();
    createFastifyPlugin({}, {}, done);
    const [arg] = done.mock.calls[0]!;
    expect(arg).toBeUndefined();
  });
});
