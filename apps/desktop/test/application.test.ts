import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearMocks,
  mockIPC,
  mockWindows,
} from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { NativeCloseRequest } from "@weblink/platform";
import { nativeApplication } from "../src/application";

interface CloseWatchArguments {
  watchId: string;
  events: Channel<NativeCloseRequest>;
}

describe("application close platform adapter", () => {
  afterEach(clearMocks);

  it("requests normal native window closing and reports failures", async () => {
    const ipc = vi.fn();
    mockIPC(ipc);
    mockWindows("main");
    await nativeApplication.requestClose();
    expect(ipc).toHaveBeenLastCalledWith(
      "plugin:window|close",
      { label: "main" },
    );
    ipc.mockRejectedValueOnce(
      new Error("Window unavailable"),
    );
    await expect(
      nativeApplication.requestClose(),
    ).rejects.toThrow("Window unavailable");
  });

  it("binds replies and remembered choices to the current page and request", async () => {
    const ipc = vi.fn();
    mockIPC(ipc);
    const receive = vi.fn();
    const session =
      await nativeApplication.watchCloseRequests(receive);
    const [command, args] = ipc.mock.calls[0] as [
      string,
      CloseWatchArguments,
    ];
    expect(command).toBe("application_close_watch");
    const request = {
      id: "close-request",
      trayAvailable: true,
    };
    args.events.onmessage(request);
    expect(receive).toHaveBeenCalledWith(request);
    await session.respond(request.id, "tray", true);
    expect(ipc).toHaveBeenLastCalledWith(
      "application_close_respond",
      {
        watchId: args.watchId,
        requestId: request.id,
        response: "tray",
        remember: true,
      },
    );
    await session.respond("next-request", "cancel", false);
    expect(ipc).toHaveBeenLastCalledWith(
      "application_close_respond",
      {
        watchId: args.watchId,
        requestId: "next-request",
        response: "cancel",
        remember: false,
      },
    );
    await session.close();
  });

  it("releases its own listener once and ignores late events and replies", async () => {
    const ipc = vi.fn();
    mockIPC(ipc);
    const receive = vi.fn();
    const session =
      await nativeApplication.watchCloseRequests(receive);
    const args = ipc.mock
      .calls[0][1] as CloseWatchArguments;
    await session.close();
    await session.close();
    expect(ipc).toHaveBeenLastCalledWith(
      "application_close_unwatch",
      { watchId: args.watchId },
    );
    expect(
      ipc.mock.calls.filter(
        ([command]) =>
          command === "application_close_unwatch",
      ),
    ).toHaveLength(1);
    args.events.onmessage({
      id: "late",
      trayAvailable: false,
    });
    expect(receive).not.toHaveBeenCalled();
    await expect(
      session.respond("late", "exit", true),
    ).rejects.toThrow("ended");
    expect(
      ipc.mock.calls.some(
        ([command]) =>
          command === "application_close_respond",
      ),
    ).toBe(false);
  });

  it("cleans up failed registration without accepting later events", async () => {
    let args: CloseWatchArguments | undefined;
    const ipc = vi.fn(async (command: string, payload) => {
      if (command === "application_close_watch") {
        args = payload as CloseWatchArguments;
        throw new Error("registration failed");
      }
    });
    mockIPC(ipc);
    const receive = vi.fn();
    await expect(
      nativeApplication.watchCloseRequests(receive),
    ).rejects.toThrow("registration failed");
    expect(ipc).toHaveBeenLastCalledWith(
      "application_close_unwatch",
      { watchId: args!.watchId },
    );
    args!.events.onmessage({
      id: "late",
      trayAvailable: true,
    });
    expect(receive).not.toHaveBeenCalled();
  });
});
