// @vitest-environment jsdom
import { createRoot, createSignal } from "solid-js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createMediaDevices } from "@/libs/hooks/media-devices";
import { createMediaDeviceAccess } from "@/libs/hooks/media-device-access";

class Permission extends EventTarget {
  constructor(public state: PermissionState = "prompt") {
    super();
  }
  change(state: PermissionState) {
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}
const device = (
  kind: MediaDeviceKind,
  label = "Device",
): MediaDeviceInfo => ({
  kind,
  deviceId: label ? `${kind}-1` : "",
  label,
  groupId: "group",
  toJSON: () => ({}),
});
const temporary = () => {
  const stop = vi.fn();
  return {
    stop,
    stream: {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream,
  };
};
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function setup(
  options: {
    query?: boolean;
    nativeOutput?: boolean;
    exposed?: boolean;
  } = {},
) {
  const statuses = {
    microphone: new Permission(),
    camera: new Permission(),
    "speaker-selection": new Permission(),
  };
  const getUserMedia =
    vi.fn<
      (
        constraints: MediaStreamConstraints,
      ) => Promise<MediaStream>
    >();
  const selectAudioOutput =
    vi.fn<() => Promise<MediaDeviceInfo>>();
  const enumerateDevices = vi.fn(async () => [
    device(
      "audioinput",
      options.exposed ? "Microphone" : "",
    ),
    device("videoinput", options.exposed ? "Camera" : ""),
  ]);
  const query = vi.fn(
    async ({ name }: PermissionDescriptor) =>
      statuses[name as keyof typeof statuses],
  );
  vi.stubGlobal("navigator", {
    mediaDevices: Object.assign(new EventTarget(), {
      enumerateDevices,
      getUserMedia,
      ...(options.nativeOutput
        ? { selectAudioOutput }
        : {}),
    }),
    ...(options.query === false
      ? {}
      : { permissions: { query } }),
  });
  const [outputSupported, setOutputSupported] =
    createSignal(true);
  const model = createRoot((dispose) => {
    disposers.push(dispose);
    const discovery = createMediaDevices();
    const access = createMediaDeviceAccess({
      devices: discovery.devices,
      refreshing: discovery.refreshing,
      refresh: discovery.updateDevices,
      outputSupported,
    });
    return { ...access, dispose };
  });
  return {
    ...model,
    statuses,
    getUserMedia,
    enumerateDevices,
    selectAudioOutput,
    query,
    setOutputSupported,
  };
}

describe("meeting device permissions", () => {
  it("inspects permissions without starting capture and separates blocked, missing and unsupported devices", async () => {
    const f = setup();
    await f.refresh();
    expect(f.state("audioinput")).toBe("prompt");
    expect(f.state("videoinput")).toBe("prompt");
    expect(f.state("audiooutput")).toBe("prompt");
    expect(f.needsPermission()).toBe(true);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    f.statuses.camera.change("denied");
    expect(f.state("videoinput")).toBe("denied");
    f.statuses.microphone.change("denied");
    await Promise.resolve();
    expect(f.needsPermission()).toBe(false);
    f.statuses.microphone.change("granted");
    f.enumerateDevices.mockResolvedValue([]);
    await f.refresh();
    expect(f.state("audioinput")).toBe("unavailable");
    f.setOutputSupported(false);
    expect(f.state("audiooutput")).toBe("unsupported");
  });

  it.each(["audioinput", "videoinput"] as const)(
    "requests only %s, exposes its list and immediately stops temporary capture",
    async (kind) => {
      const f = setup();
      await f.refresh();
      const capture = temporary();
      f.getUserMedia.mockImplementation(async () => {
        f.enumerateDevices.mockImplementation(async () => {
          expect(capture.stop).not.toHaveBeenCalled();
          return [device(kind)];
        });
        return capture.stream;
      });
      await f.request(kind);
      expect(f.getUserMedia).toHaveBeenCalledWith({
        audio: kind === "audioinput",
        video: kind === "videoinput",
      });
      expect(capture.stop).toHaveBeenCalledOnce();
      expect(f.state(kind)).toBe("granted");
      expect(f.requesting()).toBeNull();
    },
  );

  it("uses the native speaker picker without requesting microphone access", async () => {
    const f = setup({ nativeOutput: true });
    await f.refresh();
    const speaker = device("audiooutput");
    f.selectAudioOutput.mockResolvedValue(speaker);
    const pending = f.request("audiooutput");
    // Must be called within the original click, before asynchronous permission reads.
    expect(f.selectAudioOutput).toHaveBeenCalledOnce();
    expect(await pending).toBe(speaker);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.devices()).toContain(speaker);
    expect(f.state("audiooutput")).toBe("granted");
    f.statuses["speaker-selection"].change("denied");
    expect(f.state("audiooutput")).toBe("denied");
    expect(f.devices()).not.toContain(speaker);
  });

  it("uses a temporary microphone grant for speakers when native output permission is unavailable", async () => {
    const f = setup({ query: false });
    await f.refresh();
    expect(f.outputNeedsMicrophone()).toBe(true);
    const capture = temporary();
    f.getUserMedia.mockImplementation(async () => {
      f.enumerateDevices.mockResolvedValue([
        device("audioinput"),
        device("audiooutput"),
      ]);
      return capture.stream;
    });
    await f.request("audiooutput");
    expect(f.getUserMedia).toHaveBeenCalledWith({
      audio: true,
      video: false,
    });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(f.state("audioinput")).toBe("granted");
    expect(f.state("audiooutput")).toBe("granted");
  });

  it("keeps a dismissed permission retryable and reports blocked and missing devices separately", async () => {
    const f = setup();
    await f.refresh();
    f.getUserMedia.mockRejectedValue(
      new DOMException("Dismissed", "NotAllowedError"),
    );
    await f.request("videoinput");
    expect(f.state("videoinput")).toBe("prompt");
    f.statuses.camera.change("denied");
    await f.request("videoinput");
    expect(f.state("videoinput")).toBe("denied");
    f.statuses.camera.change("prompt");
    f.getUserMedia.mockRejectedValue(
      new DOMException("Missing", "NotFoundError"),
    );
    await f.request("videoinput");
    expect(f.state("videoinput")).toBe("unavailable");
    f.getUserMedia.mockRejectedValue(
      new DOMException("Busy", "NotReadableError"),
    );
    await f.request("videoinput");
    expect(f.state("videoinput")).toBe("prompt");
    expect(f.error()?.name).toBe("NotReadableError");
  });

  it("uses visible device information when permission queries are unsupported", async () => {
    const f = setup({ exposed: true });
    f.query.mockRejectedValue(
      new TypeError("Unsupported permission"),
    );
    await f.refresh();
    expect(f.state("audioinput")).toBe("granted");
    expect(f.state("videoinput")).toBe("granted");
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it("offers access when permission is granted but device identities are still hidden", async () => {
    const f = setup();
    f.statuses.camera.state = "granted";
    await f.refresh();
    expect(f.state("videoinput")).toBe("prompt");
    expect(f.needsPermission()).toBe(true);
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it("updates revoked permission and removes permission/focus listeners on disposal", async () => {
    const f = setup({ exposed: true });
    await f.refresh();
    f.statuses.camera.change("denied");
    expect(f.state("videoinput")).toBe("denied");
    f.statuses.camera.change("granted");
    expect(f.state("videoinput")).toBe("granted");
    f.dispose();
    const count = f.enumerateDevices.mock.calls.length;
    f.statuses.camera.change("denied");
    window.dispatchEvent(new Event("focus"));
    expect(f.enumerateDevices).toHaveBeenCalledTimes(count);
    expect(f.state("videoinput")).toBe("granted");
  });

  it("deduplicates permission requests and releases late capture after disposal", async () => {
    const f = setup();
    await f.refresh();
    let resolve!: (stream: MediaStream) => void;
    f.getUserMedia.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = f.request("audioinput");
    await f.request("videoinput");
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    f.dispose();
    const capture = temporary();
    resolve(capture.stream);
    await pending;
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("does not request capture in an insecure environment", async () => {
    const f = setup();
    vi.stubGlobal("isSecureContext", false);
    await f.refresh();
    expect(f.state("audioinput")).toBe("unsupported");
    await f.request("audioinput");
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
});
