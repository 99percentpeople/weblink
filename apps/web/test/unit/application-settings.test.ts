import { describe, expect, it, vi } from "vitest";
import { resolveApplicationOptions } from "@/libs/domain/application-options";
import { createApplicationSettingsSync } from "@/libs/application/application-settings";
import type { NativeApplicationOptions } from "@weblink/platform";

describe("application preferences", () => {
  it("defaults to asking and preserves explicit saved exit or tray choices", () => {
    expect(resolveApplicationOptions().closeBehavior).toBe(
      "ask",
    );
    for (const closeBehavior of [
      "ask",
      "exit",
      "tray",
    ] as const) {
      expect(
        resolveApplicationOptions({ closeBehavior })
          .closeBehavior,
      ).toBe(closeBehavior);
    }
  });
  it("migrates the old PiP switch without overriding a newer explicit choice", () => {
    expect(
      resolveApplicationOptions(undefined, "true"),
    ).toEqual({
      automaticPictureInPicture: true,
      closeBehavior: "ask",
      hideOnRemoteControl: false,
    });
    expect(
      resolveApplicationOptions(
        { automaticPictureInPicture: false },
        "true",
      ).automaticPictureInPicture,
    ).toBe(false);
    expect(
      resolveApplicationOptions(null, "broken")
        .automaticPictureInPicture,
    ).toBe(false);
  });
  it("does not enable native hiding from malformed persisted options", () => {
    expect(
      resolveApplicationOptions({
        closeBehavior: "hidden",
        hideOnRemoteControl: "true",
      } as never),
    ).toEqual({
      automaticPictureInPicture: false,
      closeBehavior: "ask",
      hideOnRemoteControl: false,
    });
  });
});

const options: NativeApplicationOptions = {
  closeBehavior: "exit",
  hideOnRemoteControl: false,
  locale: "en",
};
describe("native application configuration", () => {
  it("serializes IPC and coalesces queued changes to the latest preference", async () => {
    let finish!: () => void;
    const configure = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const error = vi.fn();
    const sync = createApplicationSettingsSync(
      { configure },
      error,
    );
    sync.update(options);
    sync.update({ ...options, closeBehavior: "tray" });
    sync.update({ ...options, locale: "zh-cn" });
    expect(configure).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() =>
      expect(configure).toHaveBeenCalledTimes(2),
    );
    expect(configure).toHaveBeenLastCalledWith({
      ...options,
      locale: "zh-cn",
    });
    expect(error).not.toHaveBeenCalled();
    sync.close();
  });
  it("reports failures and still applies a later change", async () => {
    const failure = new Error("IPC unavailable");
    const configure = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const error = vi.fn();
    const sync = createApplicationSettingsSync(
      { configure },
      error,
    );
    sync.update(options);
    sync.update({ ...options, closeBehavior: "tray" });
    await vi.waitFor(() =>
      expect(configure).toHaveBeenCalledTimes(2),
    );
    expect(error).toHaveBeenCalledWith(failure);
    sync.close();
  });
  it("discards pending changes when the application owner is disposed", async () => {
    let reject!: (error: Error) => void;
    const configure = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const error = vi.fn();
    const sync = createApplicationSettingsSync(
      { configure },
      error,
    );
    sync.update(options);
    sync.update({ ...options, closeBehavior: "tray" });
    sync.close();
    reject(new Error("closed"));
    await Promise.resolve();
    sync.update(options);
    expect(configure).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
});
