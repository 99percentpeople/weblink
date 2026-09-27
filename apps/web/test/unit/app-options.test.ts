import { describe, expect, it } from "vitest";
import {
  getDefaultAppOptions,
  resolveClientConfig,
  resolveRoomConfig,
} from "@/libs/state/app-options";

describe("app options", () => {
  it("defaults room downloads to off at 5 MB and isolates room preferences", () => {
    const options = getDefaultAppOptions();
    expect(
      resolveRoomConfig(options, "room:server-a:meeting"),
    ).toEqual({
      autoDownloadFiles: false,
      autoDownloadMaxSize: 5 * 1024 * 1024,
    });
    options.roomConfigs["room:server-a:meeting"] = {
      autoDownloadFiles: true,
      autoDownloadMaxSize: 10 * 1024 * 1024,
    };
    expect(
      resolveRoomConfig(options, "room:server-a:meeting")
        .autoDownloadFiles,
    ).toBe(true);
    expect(
      resolveRoomConfig(options, "room:server-b:meeting")
        .autoDownloadFiles,
    ).toBe(false);
  });
  it("does not expose the signaling URL as a user option", () => {
    expect(getDefaultAppOptions()).not.toHaveProperty(
      "websocketUrl",
    );
  });

  it("uses conservative single-channel transfer defaults", () => {
    const options = getDefaultAppOptions();

    expect(options).not.toHaveProperty("channelsNumber");
    expect(options.blockSize).toBe(32 * 1024);
    expect(options.bufferedAmountLowThreshold).toBe(
      64 * 1024,
    );
    expect(options.bufferedAmountHighWaterMark).toBe(
      256 * 1024,
    );
    expect(options.compressionLevel).toBe(0);
  });

  it("shares file lists by default and supports per-client privacy overrides", () => {
    const options = getDefaultAppOptions();

    expect(
      resolveClientConfig(options, "peer").provideFileList,
    ).toBe(true);

    options.clientConfigs.peer = {
      provideFileList: false,
    };
    expect(
      resolveClientConfig(options, "peer").provideFileList,
    ).toBe(false);
    expect(
      resolveClientConfig(options, "other").provideFileList,
    ).toBe(true);
  });
});
