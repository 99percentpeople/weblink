// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@weblink/platform/events";
import { SubscriptionScope } from "@weblink/platform/subscription-scope";

type Events = { changed: number; closed: void };

describe("domain event subscriptions", () => {
  it("delivers payloads synchronously in subscription order without crossing domains", () => {
    const session = new EventBus<Events>("session");
    const transfer = new EventBus<Events>("transfer");
    const trace: string[] = [];
    session.events.subscribe("changed", (value) =>
      trace.push(`first:${value}`),
    );
    session.events.subscribe("changed", (value) =>
      trace.push(`new:${value}`),
    );
    transfer.events.subscribe("changed", () =>
      trace.push("wrong domain"),
    );
    session.emit("changed", 1);
    expect(trace).toEqual(["first:1", "new:1"]);
    expect("emit" in session.events).toBe(false);
    if (false) {
      session.events.subscribe(
        "changed",
        // @ts-expect-error Topic payloads remain correlated.
        (value: string) => value,
      );
      // @ts-expect-error Undeclared topics are rejected.
      session.emit("missing", 1);
    }
  });

  it("preserves undefined and null payloads", () => {
    const bus = new EventBus<{
      value: undefined | null;
    }>("test.payload");
    const receive = vi.fn();
    bus.events.subscribe("value", receive);
    bus.emit("value", undefined);
    bus.emit("value", null);
    expect(receive.mock.calls).toEqual([
      [undefined],
      [null],
    ]);
  });

  it("gives each subscription its own idempotent disposer", () => {
    const bus = new EventBus<Events>("session");
    const receive = vi.fn();
    const first = bus.subscribe("changed", receive);
    const second = bus.subscribe("changed", receive);
    first();
    first();
    bus.emit("changed", 2);
    expect(receive).toHaveBeenCalledExactlyOnceWith(2);
    second();
    expect(bus.listenerCount).toBe(0);
  });

  it("removes once listeners before a reentrant dispatch and detaches abort hooks", () => {
    const bus = new EventBus<Events>("session");
    const controller = new AbortController();
    const remove = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const receive = vi.fn(() => bus.emit("changed", 2));
    bus.subscribe("changed", receive, {
      once: true,
      signal: controller.signal,
    });
    bus.emit("changed", 1);
    expect(receive).toHaveBeenCalledExactlyOnceWith(1);
    expect(remove).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    expect(bus.listenerCount).toBe(0);
  });

  it("abort during dispatch prevents later listeners, including pre-aborted registrations", () => {
    const bus = new EventBus<Events>("session");
    const controller = new AbortController();
    bus.subscribe("changed", () => controller.abort());
    const receive = vi.fn();
    bus.subscribe("changed", receive, {
      signal: controller.signal,
    });
    bus.emit("changed", 1);
    bus.subscribe("changed", receive, {
      signal: controller.signal,
    });
    bus.emit("changed", 2);
    expect(receive).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(1);
  });

  it("isolates synchronous and asynchronous failures with domain context", async () => {
    const error = new Error("listener failed");
    const report = vi.fn();
    const bus = new EventBus<Events>("automation", report);
    const receive = vi.fn();
    bus.subscribe("changed", () => {
      throw error;
    });
    bus.subscribe("changed", async () => {
      throw error;
    });
    bus.subscribe("changed", receive);
    bus.emit("changed", 3);
    await Promise.resolve();
    expect(receive).toHaveBeenCalledExactlyOnceWith(3);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(error, {
      domain: "automation",
      type: "changed",
    });
  });

  it("clears actual listeners and prevents new subscriptions after disposal", () => {
    const bus = new EventBus<Events>("test.lifecycle");
    const receive = vi.fn();
    const controller = new AbortController();
    const remove = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    bus.events.subscribe("changed", receive, {
      signal: controller.signal,
    });
    bus.events.subscribe("changed", receive);
    bus.clear();
    bus.emit("changed", 1);
    expect(receive).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    bus.events.subscribe("changed", receive);
    bus.emit("changed", 2);
    bus.dispose();
    bus.dispose();
    bus.events.subscribe("changed", receive);
    bus.emit("changed", 3);
    expect(receive).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("defers new subscriptions and skips those removed during delivery", () => {
    const bus = new EventBus<Events>("session");
    const trace: string[] = [];
    const late = (value: number) =>
      trace.push(`late:${value}`);
    bus.events.subscribe(
      "changed",
      () => {
        stop();
        bus.events.subscribe("changed", late);
      },
      { once: true },
    );
    const stop = bus.events.subscribe("changed", () =>
      trace.push("removed"),
    );
    bus.emit("changed", 1);
    expect(trace).toEqual([]);
    bus.emit("changed", 2);
    expect(trace).toEqual(["late:2"]);
  });

  it("stops a delivery immediately when its owner is disposed", () => {
    const bus = new EventBus<Events>("session");
    const receive = vi.fn();
    bus.events.subscribe("changed", () => bus.dispose());
    bus.events.subscribe("changed", receive);
    bus.emit("changed", 1);
    expect(receive).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(0);
  });
});

describe("subscription scopes", () => {
  it("owns event and DOM subscriptions and disposes them once with the parent", () => {
    const parent = new AbortController();
    const scope = new SubscriptionScope(parent.signal);
    const bus = new EventBus<Events>("session");
    const target = new EventTarget();
    const receive = vi.fn();
    target.addEventListener("changed", receive, {
      signal: scope.signal,
    });
    bus.subscribe("changed", receive, {
      signal: scope.signal,
    });
    const cleanup = vi.fn();
    scope.add(cleanup);
    parent.abort("session replaced");
    scope.dispose();
    target.dispatchEvent(new Event("changed"));
    bus.emit("changed", 1);
    expect(receive).not.toHaveBeenCalled();
    expect(scope.signal.reason).toBe("session replaced");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(bus.listenerCount).toBe(0);
  });

  it("releases late registrations without touching a replacement scope", async () => {
    const old = new SubscriptionScope();
    const replacement = new SubscriptionScope();
    let finish!: (stop: () => void) => void;
    const pending = old.track(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const late = vi.fn();
    const current = vi.fn();
    replacement.add(current);
    old.dispose();
    finish(late);
    (await pending)();
    expect(late).toHaveBeenCalledOnce();
    expect(current).not.toHaveBeenCalled();
    replacement.dispose();
    expect(current).toHaveBeenCalledOnce();
  });

  it("suppresses late callbacks, immediately cleans pre-aborted scopes and isolates cleanup failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = vi.fn();
    const scope = new SubscriptionScope(
      controller.signal,
      report,
    );
    const receive = vi.fn();
    scope.guard(receive)(1);
    const cleanup = vi.fn();
    scope.add(() => {
      throw new Error("sync");
    });
    scope.add(async () => {
      throw new Error("async");
    });
    scope.add(cleanup)();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
  });
});
