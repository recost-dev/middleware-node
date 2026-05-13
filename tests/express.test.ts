/**
 * Tests for src/frameworks/express.ts
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createExpressMiddleware } from "../src/frameworks/express.js";
import { isInstalled, uninstall } from "../src/core/interceptor.js";

afterEach(() => {
  uninstall();
});

describe("createExpressMiddleware", () => {
  it("initializes the SDK — interceptor is installed after call", () => {
    createExpressMiddleware();
    expect(isInstalled()).toBe(true);
  });

  it("returns an object with `middleware` and `recost`", () => {
    const adapter = createExpressMiddleware();
    expect(typeof adapter.middleware).toBe("function");
    expect(typeof adapter.recost).toBe("object");
    expect(typeof adapter.recost.dispose).toBe("function");
  });

  it("returned middleware has arity 3 (req, res, next)", () => {
    const { middleware } = createExpressMiddleware();
    expect(middleware.length).toBe(3);
  });

  it("calls next() when middleware is invoked", () => {
    const { middleware } = createExpressMiddleware();
    const next = vi.fn();
    middleware({}, {}, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("passes config to init — enabled: false does not install interceptor", () => {
    createExpressMiddleware({ enabled: false });
    expect(isInstalled()).toBe(false);
  });

  it("does not call next with an error argument under normal conditions", () => {
    const { middleware } = createExpressMiddleware();
    const next = vi.fn();
    middleware({}, {}, next);
    expect(next).toHaveBeenCalledWith();
    const [arg] = next.mock.calls[0]!;
    expect(arg).toBeUndefined();
  });

  it("returns the RecostHandle so callers can dispose after mount", async () => {
    const { middleware, recost } = createExpressMiddleware();
    expect(typeof middleware).toBe("function");
    expect(middleware.length).toBe(3);
    expect(isInstalled()).toBe(true);
    expect(typeof recost.dispose).toBe("function");

    await recost.dispose();
    expect(isInstalled()).toBe(false);
  });
});
