import { describe, expect, it, vi } from "vitest";
import {
  createMeetingMainView,
  type MeetingMainFeatures,
} from "@/routes/home/components/meeting-main-view";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let current: string | undefined = "first";
  const sources = new Set(["first", "second", "third"]);
  const decision = deferred<boolean>();
  const confirm = vi.fn(() => decision.promise);
  const onError = vi.fn();
  const shared = {
    active: vi.fn(() => false),
    stop: vi.fn(async () => true),
  };
  const main = createMeetingMainView({
    current: () => current,
    valid: (id) => !id || sources.has(id),
    confirm,
    onError,
    shared,
  });
  const owner = {
    active: vi.fn(() => true),
    stop: vi.fn(async () => true),
  };
  const unregister = main.register("first", owner);
  const apply = vi.fn((next?: string) => {
    current = next;
  });
  const change = (id?: string) =>
    main.change(id, () => apply(id));
  return {
    main,
    owner,
    shared,
    confirm,
    decision,
    onError,
    unregister,
    apply,
    change,
    sources,
    current: () => current,
  };
}

describe("main view feature ownership", () => {
  it("promotes a secondary source before starting its feature within the original call", async () => {
    const f = setup();
    f.owner.active.mockReturnValue(false);
    const start = vi.fn(() => {
      expect(f.current()).toBe("second");
    });
    const changed = f.main.change("second", () => {
      f.apply("second");
      start();
    });
    // Fullscreen and PiP must not wait for a timer or animation frame.
    expect(start).toHaveBeenCalledOnce();
    expect(await changed).toBe(true);
  });
  it("starts the secondary feature only after confirmation and previous-owner cleanup", async () => {
    const f = setup();
    const stopped = deferred<boolean>();
    f.owner.stop.mockReturnValue(stopped.promise);
    const start = vi.fn(() => {
      expect(f.current()).toBe("second");
    });
    const changed = f.main.change("second", () => {
      f.apply("second");
      start();
    });
    expect(start).not.toHaveBeenCalled();
    f.decision.resolve(true);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    stopped.resolve(true);
    expect(await changed).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });
  it("discards the secondary feature when switching is cancelled", async () => {
    const f = setup();
    const start = vi.fn();
    const changed = f.main.change("second", () => {
      f.apply("second");
      start();
    });
    f.decision.resolve(false);
    expect(await changed).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(f.current()).toBe("first");
    expect(f.owner.stop).not.toHaveBeenCalled();
  });
  it("switches immediately when the main view has no active features", async () => {
    const f = setup();
    f.owner.active.mockReturnValue(false);
    const changed = f.change("second");
    expect(f.current()).toBe("second");
    expect(await changed).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.owner.stop).not.toHaveBeenCalled();
  });
  it("keeps the view and its modes untouched when confirmation is cancelled", async () => {
    const f = setup();
    const changed = f.change("second");
    expect(f.current()).toBe("first");
    f.decision.resolve(false);
    expect(await changed).toBe(false);
    expect(f.owner.stop).not.toHaveBeenCalled();
    expect(f.shared.stop).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });
  it.each(["second", undefined])(
    "ends modes before switching to %s",
    async (next) => {
      const f = setup();
      const stopped = deferred<boolean>();
      f.owner.stop.mockReturnValue(stopped.promise);
      const changed = f.change(next);
      f.decision.resolve(true);
      await Promise.resolve();
      expect(f.owner.stop).toHaveBeenCalledOnce();
      expect(f.current()).toBe("first");
      stopped.resolve(true);
      expect(await changed).toBe(true);
      expect(f.current()).toBe(next);
    },
  );
  it("does not interrupt the same main source, including pinning a single implicit main tile", async () => {
    const f = setup();
    expect(await f.change("first")).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.owner.stop).not.toHaveBeenCalled();
  });
  it("serializes repeated changes without replacing the pending confirmation", async () => {
    const f = setup();
    const changed = f.change("second");
    expect(await f.change("third")).toBe(false);
    expect(f.confirm).toHaveBeenCalledOnce();
    f.decision.resolve(true);
    expect(await changed).toBe(true);
    expect(f.current()).toBe("second");
  });
  it.each([
    "source removed",
    "room changed",
    "owner replaced",
    "main changed",
  ])("ignores stale approval after %s", async (reason) => {
    const f = setup();
    const changed = f.change("second");
    if (reason === "source removed")
      f.sources.delete("second");
    if (reason === "room changed") f.main.invalidate();
    if (reason === "owner replaced")
      f.main.register("first", { ...f.owner });
    if (reason === "main changed") f.apply("third");
    f.decision.resolve(true);
    expect(await changed).toBe(false);
    expect(f.owner.stop).not.toHaveBeenCalled();
    expect(f.current()).not.toBe("second");
  });
  it("keeps the main view when a display mode cannot exit", async () => {
    const f = setup();
    f.owner.stop.mockResolvedValue(false);
    const changed = f.change("second");
    f.decision.resolve(true);
    expect(await changed).toBe(false);
    expect(f.current()).toBe("first");
    expect(f.onError).toHaveBeenCalledOnce();
  });
  it("checks the room again after asynchronous display cleanup", async () => {
    const f = setup();
    const stopped = deferred<boolean>();
    f.owner.stop.mockReturnValue(stopped.promise);
    const changed = f.change("second");
    f.decision.resolve(true);
    await Promise.resolve();
    f.main.invalidate();
    stopped.resolve(true);
    expect(await changed).toBe(false);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("guards document PiP even after the original tile unmounts", async () => {
    const f = setup();
    f.unregister();
    f.shared.active.mockReturnValue(true);
    const changed = f.change("second");
    f.decision.resolve(true);
    expect(await changed).toBe(true);
    expect(f.shared.stop).toHaveBeenCalledOnce();
    expect(f.owner.stop).not.toHaveBeenCalled();
  });
  it("old cleanup cannot unregister a replacement owner", () => {
    const f = setup();
    const replacement: MeetingMainFeatures = {
      active: () => true,
      stop: async () => true,
    };
    f.main.register("first", replacement);
    f.unregister();
    expect(f.main.active()).toBe(true);
  });
  it("cancels the removed source's pending control and discards its outstanding confirmation", async () => {
    const f = setup();
    const changed = f.change("second");
    f.main.remove("first");
    expect(f.owner.stop).toHaveBeenCalledOnce();
    f.decision.resolve(true);
    expect(await changed).toBe(false);
    expect(f.apply).not.toHaveBeenCalled();
  });
});
