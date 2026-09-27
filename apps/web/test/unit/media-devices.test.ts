// @vitest-environment jsdom
import { createRoot } from "solid-js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createMediaDevices } from "@/libs/hooks/media-devices";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function setup(
  media?: EventTarget & {
    enumerateDevices(): Promise<MediaDeviceInfo[]>;
  },
) {
  vi.stubGlobal("navigator", { mediaDevices: media });
  return createRoot((dispose) => {
    disposers.push(dispose);
    return { ...createMediaDevices(), dispose };
  });
}

function device(id: string): MediaDeviceInfo {
  return {
    deviceId: id,
    kind: "audioinput",
    groupId: "",
    label: id,
    toJSON: () => ({}),
  };
}

describe("meeting media device discovery", () => {
  it("allows an unsupported browser to show an empty device picker", async () => {
    const model = setup();
    await model.updateDevices();
    expect(model.devices()).toEqual([]);
    expect(model.error()).toBeNull();
    expect(model.refreshing()).toBe(false);
  });

  it("refreshes plugged-in devices and removes its listener on disposal", async () => {
    const media = Object.assign(new EventTarget(), {
      enumerateDevices: vi.fn(async () => [
        device("mic-a"),
      ]),
    });
    const model = setup(media);
    await vi.waitFor(() =>
      expect(model.devices()[0]?.deviceId).toBe("mic-a"),
    );
    media.enumerateDevices.mockResolvedValue([
      device("mic-b"),
    ]);
    media.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() =>
      expect(model.devices()[0]?.deviceId).toBe("mic-b"),
    );
    model.dispose();
    const calls = media.enumerateDevices.mock.calls.length;
    media.dispatchEvent(new Event("devicechange"));
    expect(media.enumerateDevices).toHaveBeenCalledTimes(
      calls,
    );
  });

  it("ignores an old enumeration that finishes after a newer refresh", async () => {
    let resolveOld!: (value: MediaDeviceInfo[]) => void;
    const media = Object.assign(new EventTarget(), {
      enumerateDevices: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<MediaDeviceInfo[]>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValue([device("current")]),
    });
    const model = setup(media);
    await model.updateDevices();
    resolveOld([device("outdated")]);
    await Promise.resolve();
    expect(model.devices()[0]?.deviceId).toBe("current");
  });

  it("does not publish an enumeration error after the picker is disposed", async () => {
    let reject!: (error: Error) => void;
    const media = Object.assign(new EventTarget(), {
      enumerateDevices: vi.fn(
        () =>
          new Promise<MediaDeviceInfo[]>((_, fail) => {
            reject = fail;
          }),
      ),
    });
    const model = setup(media);
    model.dispose();
    reject(new Error("Permission denied"));
    await Promise.resolve();
    expect(model.error()).toBeNull();
    expect(model.devices()).toEqual([]);
  });
});
