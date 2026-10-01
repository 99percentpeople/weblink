import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { nativeKeyboard } from "../src/keyboard";
describe("system keyboard platform adapter", () => {
  afterEach(clearMocks);
  it("checks native capability and scopes start, renew and cleanup to the same id", async () => {
    const ipc = vi.fn(async (command: string) =>
      command === "runtime_capabilities"
        ? { systemKeyboard: true }
        : undefined,
    );
    mockIPC(ipc);
    expect(await nativeKeyboard.supported()).toBe(true);
    const event = vi.fn();
    const session = await nativeKeyboard.start(
      "ctrl-alt-shift-x",
      event,
    );
    const start = (
      ipc.mock.calls as unknown as [
        string,
        Record<string, any>,
      ][]
    ).find(([c]) => c === "keyboard_start")![1];
    expect(start.exitShortcut).toBe("ctrl-alt-shift-x");
    await session.renew(3);
    expect(ipc).toHaveBeenLastCalledWith("keyboard_renew", {
      sessionId: start.sessionId,
      sequence: 3,
    });
    await session.close();
    await session.close();
    expect(ipc).toHaveBeenLastCalledWith("keyboard_stop", {
      sessionId: start.sessionId,
    });
    expect(
      ipc.mock.calls.filter(([c]) => c === "keyboard_stop"),
    ).toHaveLength(1);
    await expect(session.renew(4)).rejects.toThrow(
      "closed",
    );
  });
  it("cleans up an unsuccessful startup", async () => {
    const ipc = vi.fn(async (command: string) => {
      if (command === "keyboard_start")
        throw new Error("no focus");
    });
    mockIPC(ipc);
    await expect(
      nativeKeyboard.start("ctrl-alt-shift-q", () => {}),
    ).rejects.toThrow("no focus");
    expect(ipc).toHaveBeenLastCalledWith(
      "keyboard_stop",
      expect.objectContaining({
        sessionId: expect.any(String),
      }),
    );
  });
});
