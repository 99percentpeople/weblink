import { describe, expect, it, vi } from "vitest";
import { parseCall } from "@weblink/automation";
import type {
  NativeEncoder,
  PlatformRuntime,
} from "@weblink/platform";
import {
  getDefaultAppOptions,
  type AppOption,
} from "@/libs/state/app-options";
import { createScreenSettings } from "@/libs/application/automation/screen-settings";

function fixture(
  kind: PlatformRuntime["kind"] = "desktop",
) {
  const options = getDefaultAppOptions();
  options.nativeEncoderPresets = {
    software: "quality",
    "mf:test": "latency",
  };
  const encoders = vi.fn(
    async (): Promise<NativeEncoder[]> => [
      {
        id: "software",
        name: "Software",
        hardware: false,
        codecs: ["video/vp8", "video/h264"],
        presets: ["balanced", "quality", "latency"],
      },
      {
        id: "mf:test",
        name: "Hardware",
        hardware: true,
        codecs: ["video/h264"],
        presets: ["balanced", "latency"],
      },
    ],
  );
  const write = vi.fn((patch: Partial<AppOption>) => {
    Object.assign(options, patch);
  });
  const platform = {
    kind,
    screenShare: { encoders },
    capture: {
      backends: vi.fn(async () => ({
        screen: [{ id: "wgc", name: "WGC" }],
        window: [{ id: "wgc", name: "WGC" }],
      })),
    },
  } as unknown as PlatformRuntime;
  const run = createScreenSettings({
    platform,
    read: () => options,
    write,
  });
  const controller = new AbortController();
  const check = vi.fn(async () => {});
  const invoke = (patch?: Record<string, unknown>) =>
    run(
      {
        name: patch
          ? "screen.settings.update"
          : "screen.settings.get",
        arguments: {
          target: "local",
          ...(patch ? { patch } : {}),
        },
      },
      controller.signal,
      check,
    );
  return {
    options,
    encoders,
    write,
    platform,
    controller,
    check,
    invoke,
  };
}

describe("MCP video preferences", () => {
  it("reads only whitelisted preferences and discovered choices without writing", async () => {
    const f = fixture();
    const result = await f.invoke();
    expect(result.settings).toEqual({
      resolution: "1080p",
      frameRate: 30,
      maxBitrate: 25 * 1024 * 1024,
      degradationPreference: "balanced",
      encoder: "auto",
      codec: "auto",
      preset: "balanced",
      readbackBuffers: 2,
      colorMatrix: "auto",
      colorRange: "limited",
      screenCaptureBackend: "auto",
      windowCaptureBackend: "wgc",
    });
    expect(result.capabilities).toMatchObject({
      encoders: [
        {
          id: "software",
          presets: ["balanced", "quality", "latency"],
        },
        { id: "mf:test", presets: ["balanced", "latency"] },
      ],
      captureBackends: {
        screen: ["auto", "wgc"],
        window: ["wgc"],
      },
    });
    expect(f.write).not.toHaveBeenCalled();
  });

  it("commits one patch, preserves other options and remembers presets per encoder", async () => {
    const f = fixture();
    const before = structuredClone(f.options);
    const result = await f.invoke({
      encoder: "software",
      codec: "video/h264",
      preset: "latency",
      frameRate: 120,
    });
    expect(f.write).toHaveBeenCalledExactlyOnceWith({
      nativeScreenEncoder: "software",
      nativeScreenCodec: "video/h264",
      nativeEncoderPresets: {
        software: "latency",
        "mf:test": "latency",
      },
      videoFrameRate: 120,
    });
    expect(f.options).toEqual({
      ...before,
      ...f.write.mock.calls[0][0],
    });
    expect(result).toMatchObject({
      updated: true,
      previous: {
        encoder: "auto",
        preset: "balanced",
        frameRate: 30,
      },
      settings: {
        encoder: "software",
        preset: "latency",
        frameRate: 120,
      },
      application: {
        liveUpdateRequested: ["frameRate"],
        nextShare: ["encoder", "codec", "preset"],
      },
    });
    await f.invoke({ encoder: "mf:test" });
    expect(f.options.nativeEncoderPresets.software).toBe(
      "latency",
    );
    await f.invoke({ preset: "balanced" });
    await f.invoke({ encoder: "software" });
    expect((await f.invoke()).settings).toMatchObject({
      preset: "latency",
    });
    await f.invoke({ encoder: "auto", codec: "auto" });
    expect(f.options.nativeScreenCodec).toBeNull();
  });

  it("restores the newly selected encoder's saved preset and preserves concurrent UI edits", async () => {
    const f = fixture();
    f.check.mockImplementation(async () => {
      // An edit while native discovery/authorization is in flight.
      f.options.videoFrameRate = 144;
    });
    const result = await f.invoke({
      encoder: "software",
      codec: "video/h264",
    });
    expect(result.settings).toMatchObject({
      preset: "quality",
      frameRate: 144,
    });
    expect(result.application).toMatchObject({
      liveUpdateRequested: [],
    });
    expect(f.options.nativeEncoderPresets.software).toBe(
      "quality",
    );
  });

  it.each([
    {},
    { frameRate: 0 },
    { frameRate: 60.5 },
    { frameRate: 1001 },
    { maxBitrate: 131071 },
    { maxBitrate: 157286401 },
    { readbackBuffers: 4 },
    { encoder: "missing", codec: "video/h264" },
    { encoder: "mf:test", codec: "video/vp8" },
    { encoder: "auto", codec: "video/h264" },
    { encoder: "software" },
    {
      encoder: "mf:test",
      codec: "video/h264",
      preset: "quality",
    },
    { screenCaptureBackend: "dxgi" },
    { windowCaptureBackend: "auto" },
    {
      encoder: "software",
      codec: "video/vp8",
      colorRange: "full",
    },
    {
      encoder: "software",
      codec: "video/vp8",
      colorMatrix: "bt709",
    },
    { automation: { enabled: true } },
    { turnServers: [] },
    { preset: "fast" },
  ])(
    "rejects invalid patches atomically: %j",
    async (patch) => {
      const f = fixture();
      const before = structuredClone(f.options);
      await expect(f.invoke(patch)).rejects.toMatchObject({
        code: "INVALID_ARGUMENTS",
      });
      expect(f.write).not.toHaveBeenCalled();
      expect(f.options).toEqual(before);
    },
  );

  it.each([
    "screen.settings.get",
    "screen.settings.update",
  ])(
    "uses the existing permission boundary for %s",
    (name) => {
      const tool = parseCall({
        name,
        arguments: {
          target: "peer",
          ...(name.endsWith("update")
            ? { patch: { preset: "latency" } }
            : {}),
        },
      });
      expect(tool.scope).toBe(
        name.endsWith("get")
          ? "screen.read"
          : "screen.configure",
      );
      expect(tool.native).toBe(true);
      expect(tool.readOnly).toBe(name.endsWith("get"));
      expect(() =>
        parseCall({ name, arguments: {} }),
      ).toThrow();
    },
  );

  it.each(["cancel", "revoke", "discovery"])(
    "does not save after %s during discovery",
    async (failure) => {
      const f = fixture();
      f.encoders.mockImplementation(async () => {
        if (failure === "cancel") f.controller.abort();
        if (failure === "revoke")
          f.check.mockRejectedValue(
            new Error("GRANT_EXPIRED"),
          );
        if (failure === "discovery")
          throw new Error("Discovery failed");
        return [];
      });
      await expect(
        f.invoke({ frameRate: 120 }),
      ).rejects.toThrow();
      expect(f.write).not.toHaveBeenCalled();
    },
  );

  it("does not probe or save for cancelled calls or browser targets", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(
      f.invoke({ frameRate: 120 }),
    ).rejects.toThrow();
    expect(f.encoders).not.toHaveBeenCalled();
    const browser = fixture("browser");
    await expect(
      browser.invoke({ frameRate: 120 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(browser.write).not.toHaveBeenCalled();
  });
});
