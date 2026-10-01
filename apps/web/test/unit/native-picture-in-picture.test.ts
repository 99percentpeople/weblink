import { describe, expect, it, vi } from "vitest";
import type {
  NativePipSession,
  NativePipState,
} from "@weblink/platform";
import { createNativePictureInPicture } from "@/libs/application/native-picture-in-picture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const ready = deferred<NativePipSession>();
  let emit!: (state: NativePipState) => void;
  const session = {
    configure: vi.fn(async () => {}),
    enter: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    drag: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const update = vi.fn();
  const error = vi.fn();
  const pip = createNativePictureInPicture(
    {
      watch: async (onState) => {
        emit = onState;
        return ready.promise;
      },
    },
    update,
    error,
  );
  return {
    ready,
    session,
    update,
    error,
    pip,
    emit: (state: NativePipState) => emit(state),
  };
}
describe("native compact-window ownership", () => {
  it("waits for subscription and configures the latest source before entering", async () => {
    const f = fixture();
    f.pip.configure({ eligible: false, automatic: true });
    const opening = f.pip.enter();
    f.pip.configure({ eligible: true, automatic: false });
    expect(f.session.enter).not.toHaveBeenCalled();
    f.ready.resolve(f.session);
    await opening;
    expect(f.session.configure).toHaveBeenCalledWith({
      eligible: true,
      automatic: false,
    });
    expect(f.session.enter).toHaveBeenCalledOnce();
    await f.pip.close();
  });
  it("a pending entry cannot overtake exit and session cleanup", async () => {
    const f = fixture();
    const entered = deferred<void>();
    f.session.enter.mockReturnValue(entered.promise);
    f.ready.resolve(f.session);
    f.pip.configure({ eligible: true, automatic: false });
    const opening = f.pip.enter();
    await vi.waitFor(() =>
      expect(f.session.enter).toHaveBeenCalledOnce(),
    );
    const exiting = f.pip.exit();
    expect(f.session.exit).not.toHaveBeenCalled();
    entered.resolve();
    await opening;
    await exiting;
    expect(f.session.exit).toHaveBeenCalledOnce();
    await f.pip.close();
    expect(f.session.close).toHaveBeenCalledOnce();
  });
  it("discards queued entry and late native state after owner disposal", async () => {
    const f = fixture();
    f.pip.configure({ eligible: true, automatic: true });
    void f.pip.enter();
    const closing = f.pip.close();
    f.ready.resolve(f.session);
    await closing;
    f.emit({
      active: true,
      transitioning: false,
      titleBarHeight: 31,
    });
    expect(f.session.enter).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalledOnce();
    expect(f.update).not.toHaveBeenCalled();
    await f.pip.close();
    expect(f.session.close).toHaveBeenCalledOnce();
  });
  it("does not enter after the selected source ends during configuration", async () => {
    const f = fixture();
    const configured = deferred<void>();
    f.ready.resolve(f.session);
    f.pip.configure({ eligible: true, automatic: false });
    f.session.configure.mockReturnValue(configured.promise);
    const opening = f.pip.enter();
    await vi.waitFor(() =>
      expect(f.session.configure).toHaveBeenCalled(),
    );
    f.pip.configure({ eligible: false, automatic: false });
    configured.resolve();
    await opening;
    expect(f.session.enter).not.toHaveBeenCalled();
    await f.pip.close();
  });
  it("reports subscription failure once without issuing native operations", async () => {
    const error = vi.fn();
    const failure = new Error("unavailable");
    const pip = createNativePictureInPicture(
      {
        watch: async () => {
          throw failure;
        },
      },
      vi.fn(),
      error,
    );
    pip.configure({ eligible: true, automatic: true });
    await pip.enter();
    await pip.exit();
    await pip.close();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(failure);
  });
  it("still restores after a failed entry", async () => {
    const f = fixture();
    f.ready.resolve(f.session);
    const failure = new Error("window unavailable");
    f.session.enter.mockRejectedValue(failure);
    f.pip.configure({ eligible: true, automatic: false });
    await f.pip.enter();
    await f.pip.exit();
    expect(f.error).toHaveBeenCalledWith(failure);
    expect(f.session.exit).toHaveBeenCalledOnce();
    await f.pip.close();
  });
});
