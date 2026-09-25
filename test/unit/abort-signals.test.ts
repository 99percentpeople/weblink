import { describe, expect, it, vi } from "vitest";
import { combineAbortSignals } from "@/libs/utils/abort-signals";

describe("combined operation cancellation", () => {
  it.each([0, 1])(
    "forwards source %i's first reason and releases both listeners",
    (index) => {
      const sources = [
        new AbortController(),
        new AbortController(),
      ];
      const removals = sources.map(({ signal }) =>
        vi.spyOn(signal, "removeEventListener"),
      );
      const combined = combineAbortSignals(
        sources.map(({ signal }) => signal),
      );
      const aborted = vi.fn();
      combined.signal.addEventListener("abort", aborted);
      const reason = new Error("operation ended");
      sources[index].abort(reason);
      sources[1 - index].abort(
        new Error("later cancellation"),
      );
      expect(combined.signal.reason).toBe(reason);
      expect(aborted).toHaveBeenCalledOnce();
      for (const removal of removals)
        expect(removal).toHaveBeenCalledOnce();
      combined.dispose();
      for (const removal of removals)
        expect(removal).toHaveBeenCalledOnce();
    },
  );

  it("preserves an already cancelled source and releases earlier subscriptions", () => {
    const first = new AbortController();
    const cancelled = new AbortController();
    const last = new AbortController();
    cancelled.abort("room changed");
    const remove = vi.spyOn(
      first.signal,
      "removeEventListener",
    );
    const add = vi.spyOn(last.signal, "addEventListener");
    const combined = combineAbortSignals([
      undefined,
      first.signal,
      cancelled.signal,
      last.signal,
    ]);
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe("room changed");
    expect(remove).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
    expect(first.signal.aborted).toBe(false);
    combined.dispose();
  });

  it("releases subscriptions after completion without cancelling either source", () => {
    const source = new AbortController();
    const add = vi.spyOn(source.signal, "addEventListener");
    const remove = vi.spyOn(
      source.signal,
      "removeEventListener",
    );
    const combined = combineAbortSignals([
      source.signal,
      source.signal,
    ]);
    expect(add).toHaveBeenCalledOnce();
    combined.dispose();
    expect(remove).toHaveBeenCalledOnce();
    expect(source.signal.aborted).toBe(false);
    source.abort();
    expect(combined.signal.aborted).toBe(false);
  });
});
