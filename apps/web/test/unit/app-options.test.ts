import {
  resolveRemoteFileLimit,
  MAX_REMOTE_FILE_BYTES,
} from "@/libs/domain/protocol/remote-file-limits";
import { describe, expect, it } from "vitest";
import {
  getDefaultAppOptions,
  resolveClientConfig,
  resolveRoomConfig,
  resolveRoomDownloadOptions,
  getRoomAutoDownloadLimit,
} from "@/libs/state/app-options";

describe("app options", () => {
  it("defaults the shared remote file budget and normalizes invalid persisted limits", () => {
    expect(getDefaultAppOptions().remoteFileMaxSize).toBe(
      64 * 1024 * 1024,
    );
    for (const value of [
      undefined,
      null,
      "128",
      0,
      -1,
      NaN,
      Infinity,
      1.5,
      MAX_REMOTE_FILE_BYTES + 1,
    ])
      expect(resolveRemoteFileLimit(value)).toBe(
        64 * 1024 * 1024,
      );
    expect(resolveRemoteFileLimit(128 * 1024 * 1024)).toBe(
      128 * 1024 * 1024,
    );
    expect(
      resolveRemoteFileLimit(MAX_REMOTE_FILE_BYTES),
    ).toBe(MAX_REMOTE_FILE_BYTES);
  });
  it("keeps room permission switches independent while sharing the application size limit", () => {
    const options = getDefaultAppOptions();
    expect(
      resolveRoomConfig(options, "room:server-a:meeting"),
    ).toEqual({
      autoDownloadFiles: false,
    });
    expect(options.autoDownloadMaxSize).toBe(
      5 * 1024 * 1024,
    );
    options.roomConfigs["room:server-a:meeting"] = {
      autoDownloadFiles: true,
    };
    expect(
      resolveRoomConfig(options, "room:server-a:meeting")
        .autoDownloadFiles,
    ).toBe(true);
    expect(
      resolveRoomConfig(options, "room:server-b:meeting")
        .autoDownloadFiles,
    ).toBe(false);
    options.roomConfigs["another-enabled-room"] = {
      autoDownloadFiles: true,
    };
    options.autoDownloadMaxSize = 10 * 1024 * 1024;
    expect(
      getRoomAutoDownloadLimit(
        options,
        "room:server-a:meeting",
      ),
    ).toBe(options.autoDownloadMaxSize);
    expect(
      getRoomAutoDownloadLimit(
        options,
        "another-enabled-room",
      ),
    ).toBe(options.autoDownloadMaxSize);
    expect(
      getRoomAutoDownloadLimit(
        options,
        "room:server-b:meeting",
      ),
    ).toBe(0);
  });

  it("migrates the smallest enabled room limit and removes size fields from permissions", () => {
    const saved = {
      roomConfigs: {
        first: {
          name: "First",
          autoDownloadFiles: true,
          autoDownloadMaxSize: 10 * 1024 * 1024,
        },
        second: {
          autoDownloadFiles: true,
          autoDownloadMaxSize: 20 * 1024 * 1024,
        },
        disabled: {
          autoDownloadFiles: false,
          autoDownloadMaxSize: 1024 * 1024,
        },
      },
    };
    const migrated = resolveRoomDownloadOptions(saved);
    expect(migrated.autoDownloadMaxSize).toBe(
      10 * 1024 * 1024,
    );
    expect(migrated.roomConfigs).toEqual({
      first: { name: "First", autoDownloadFiles: true },
      second: { autoDownloadFiles: true },
      disabled: { autoDownloadFiles: false },
    });
    expect(
      saved.roomConfigs.first.autoDownloadMaxSize,
    ).toBe(10 * 1024 * 1024);
    expect(resolveRoomDownloadOptions(migrated)).toEqual(
      migrated,
    );
    expect(
      resolveRoomDownloadOptions({
        ...saved,
        autoDownloadMaxSize: 50 * 1024 * 1024,
      }).autoDownloadMaxSize,
    ).toBe(50 * 1024 * 1024);
  });

  it("preserves saved limits when all rooms are disabled and falls back for invalid sizes", () => {
    expect(
      resolveRoomDownloadOptions({
        roomConfigs: {
          room: {
            autoDownloadFiles: false,
            autoDownloadMaxSize: 1024 * 1024,
          },
        },
      }).autoDownloadMaxSize,
    ).toBe(1024 * 1024);
    for (const size of [
      undefined,
      null,
      0,
      -1,
      NaN,
      Infinity,
      "large",
    ]) {
      expect(
        resolveRoomDownloadOptions({
          autoDownloadMaxSize: size,
          roomConfigs: {
            room: {
              autoDownloadFiles: true,
              autoDownloadMaxSize: size,
            },
          },
        }).autoDownloadMaxSize,
      ).toBe(5 * 1024 * 1024);
    }
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
