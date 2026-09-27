import { describe, it, expect, vi } from "vitest";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";

interface MyEvents {
  data: { message: string };
  error: Error;
}

describe("EventEmitter", () => {
  it("should add and trigger event listeners", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    const dataHandler = vi.fn(
      (event: CustomEvent<MyEvents["data"]>) => {
        expect(event.detail.message).toBe("Hello, World!");
      },
    );

    emitter.addEventListener("data", dataHandler);

    emitter.dispatchEvent("data", {
      message: "Hello, World!",
    });

    expect(dataHandler).toHaveBeenCalledTimes(1);
  });

  it("should support once option", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    const dataHandler = vi.fn();

    emitter.addEventListener("data", dataHandler, {
      once: true,
    });

    emitter.dispatchEvent("data", {
      message: "First call",
    });
    emitter.dispatchEvent("data", {
      message: "Second call",
    });

    expect(dataHandler).toHaveBeenCalledTimes(1);
  });

  it("should support signal option", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    const controller = new AbortController();

    const dataHandler = vi.fn();

    emitter.addEventListener("data", dataHandler, {
      signal: controller.signal,
    });

    emitter.dispatchEvent("data", {
      message: "Before abort",
    });

    controller.abort();

    emitter.dispatchEvent("data", {
      message: "After abort",
    });

    expect(dataHandler).toHaveBeenCalledTimes(1);
  });

  it("should remove event listeners", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    const dataHandler = vi.fn();

    emitter.addEventListener("data", dataHandler);

    emitter.dispatchEvent("data", {
      message: "First call",
    });

    emitter.removeEventListener("data", dataHandler);

    emitter.dispatchEvent("data", {
      message: "Second call",
    });

    expect(dataHandler).toHaveBeenCalledTimes(1);
  });

  it("should handle multiple listeners for the same event", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.addEventListener("data", handler1);
    emitter.addEventListener("data", handler2);

    emitter.dispatchEvent("data", {
      message: "Test message",
    });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("should pass the correct event detail", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    emitter.addEventListener("data", (event) => {
      expect(event.detail.message).toBe("Correct message");
    });

    emitter.dispatchEvent("data", {
      message: "Correct message",
    });
  });

  it("should support custom events with error type", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    emitter.addEventListener("error", (event) => {
      expect(event.detail).toBeInstanceOf(Error);
      expect(event.detail.message).toBe(
        "Something went wrong",
      );
    });

    emitter.dispatchEvent(
      "error",
      new Error("Something went wrong"),
    );
  });

  it("should not fail if removing a non-existent listener", () => {
    const emitter = new MultiEventEmitter<MyEvents>();

    const dataHandler = vi.fn();

    emitter.removeEventListener("data", dataHandler);

    emitter.addEventListener("data", dataHandler);
    emitter.removeEventListener("data", dataHandler);

    emitter.dispatchEvent("data", {
      message: "Test message",
    });

    expect(dataHandler).not.toHaveBeenCalled();
  });
});
