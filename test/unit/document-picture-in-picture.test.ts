// @vitest-environment jsdom
import { createRoot } from "solid-js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDocumentPictureInPicture } from "@/libs/hooks/document-picture-in-picture";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups.splice(0).forEach((dispose) => dispose()),
);
function setup() {
  let resolve!: (window: Window) => void;
  let reject!: (error: unknown) => void;
  const api = {
    requestWindow: vi.fn(
      () =>
        new Promise<Window>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    ),
  };
  const onError = vi.fn();
  const onClose = vi.fn();
  const current = Object.assign(new EventTarget(), {
    closed: false,
    close: vi.fn(),
  }) as unknown as Window;
  const state = createRoot((dispose) => {
    cleanups.push(dispose);
    return {
      controller: createDocumentPictureInPicture({
        api,
        onError,
        onClose,
      }),
      dispose,
    };
  });
  return {
    ...state,
    api,
    onError,
    onClose,
    current,
    resolve: () => resolve(current),
    reject: (error: unknown) => reject(error),
  };
}

describe("document picture-in-picture window ownership", () => {
  it("requests synchronously, coalesces concurrent requests, and tracks native close", async () => {
    const f = setup();
    const first = f.controller.open();
    expect(f.api.requestWindow).toHaveBeenCalledOnce();
    expect(f.controller.busy()).toBe(true);
    expect(f.controller.open()).toBe(first);
    f.resolve();
    await first;
    expect(f.controller.window()).toBe(f.current);
    expect(f.controller.busy()).toBe(false);
    await f.controller.open();
    expect(f.api.requestWindow).toHaveBeenCalledOnce();
    f.current.dispatchEvent(new Event("pagehide"));
    expect(f.controller.active()).toBe(false);
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it.each(["close", "dispose"] as const)(
    "closes a late result after %s without publishing it",
    async (action) => {
      const f = setup();
      const result = f.controller.open();
      if (action === "close") f.controller.close();
      else f.dispose();
      f.resolve();
      await result;
      expect(f.current.close).toHaveBeenCalledOnce();
      expect(f.controller.window()).toBeUndefined();
      expect(f.onError).not.toHaveBeenCalled();
    },
  );
  it("reports denied requests once and allows a later user retry", async () => {
    const f = setup();
    const denied = new DOMException(
      "No activation",
      "NotAllowedError",
    );
    const first = f.controller.open();
    f.reject(denied);
    await first;
    expect(f.onError).toHaveBeenCalledWith(denied);
    expect(f.controller.busy()).toBe(false);
    const next = f.controller.open();
    f.resolve();
    await next;
    expect(f.controller.active()).toBe(true);
    f.dispose();
    expect(f.current.close).toHaveBeenCalledOnce();
    f.current.dispatchEvent(new Event("pagehide"));
    expect(f.onClose).not.toHaveBeenCalled();
  });
});
