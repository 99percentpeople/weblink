import { describe, expect, it } from "vitest";
import {
  getDefaultAppOptions,
  resolveClientConfig,
} from "@/libs/state/app-options";

describe("app options", () => {
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
