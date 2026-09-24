// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MeetingControls } from "@/routes/home/components/meeting-controls";
import type { MeetingDeviceAccessState } from "@/libs/domain/meeting-devices";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
let animationStyle: HTMLStyleElement;
beforeEach(() => {
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.unstubAllGlobals();
});

async function chooseDevice(
  trigger: HTMLElement,
  id: string,
) {
  await userEvent.click(trigger);
  await userEvent.click(
    screen
      .getAllByRole("option")
      .find((option) => option.dataset.deviceId === id)!,
  );
}

function setup(withDevices = false) {
  const [collapsed, setCollapsed] = createSignal(false);
  const [microphoneOn, setMicrophoneOn] =
    createSignal(false);
  const [cameraOn, setCameraOn] = createSignal(false);
  const [sharing, setSharing] = createSignal(false);
  const [cameraBusy, setCameraBusy] = createSignal(false);
  const [sharingBusy, setSharingBusy] = createSignal(false);
  const [microphoneId, setMicrophoneId] = createSignal("");
  const [cameraId, setCameraId] = createSignal("");
  const [outputId, setOutputId] = createSignal("");
  const [outputSupported, setOutputSupported] =
    createSignal(true);
  const [requesting, setRequesting] =
    createSignal<MediaDeviceKind | null>(null);
  const [permissions, setPermissions] = createSignal<
    Record<MediaDeviceKind, MeetingDeviceAccessState>
  >({
    audioinput: "granted",
    audiooutput: "granted",
    videoinput: "granted",
  });
  const device = (
    kind: MediaDeviceKind,
    deviceId: string,
    label = "",
  ) =>
    ({
      kind,
      deviceId,
      label,
      groupId: "",
      toJSON: () => ({}),
    }) as MediaDeviceInfo;
  const [list, setList] = createSignal<
    readonly MediaDeviceInfo[]
  >([
    device("audioinput", "default"),
    device("audioinput", "communications"),
    device("audioinput", ""),
    device("audioinput", "mic-1", "Studio microphone"),
    device("audioinput", "mic-1", "Duplicate"),
    device("audioinput", "mic-2"),
    device("videoinput", "camera-1", "Webcam"),
    device("audiooutput", "speaker-1", "Speakers"),
  ]);
  const devices = {
    access: {
      state: (kind: MediaDeviceKind) => permissions()[kind],
      requesting,
      needsPermission: () => false,
      outputNeedsMicrophone: vi.fn(() => false),
      request: vi.fn(async () => {}),
    },
    list,
    refreshing: () => false,
    refresh: vi.fn(),
    microphoneId,
    cameraId,
    outputId,
    selectMicrophone: vi.fn(async (id: string) => {
      setMicrophoneId(id);
    }),
    selectCamera: vi.fn(async (id: string) => {
      setCameraId(id);
    }),
    selectOutput: vi.fn(async (id: string) => {
      setOutputId(id);
    }),
    outputSupported,
    outputBusy: () => false,
  };
  const onLeave = vi.fn();
  const onToggleAudio = vi.fn();
  const onToggleLayout = vi.fn();
  const toggleCamera = vi.fn(async () => {
    setCameraOn((value) => !value);
  });
  const media = {
    microphoneOn,
    audioAvailable: () => true,
    audioOn: microphoneOn,
    setAudioEnabled: setMicrophoneOn,
    cameraOn,
    sharing,
    sharingSupported: () => true,
    sharingAudioAvailable: () => false,
    sharingAudioOn: () => false,
    setSharingAudioEnabled: vi.fn(),
    videoBusy: () => cameraBusy() || sharingBusy(),
    cameraBusy,
    sharingBusy,
    microphoneBusy: () => false,
    error: () => null,
    toggleMicrophone: async () => {
      setMicrophoneOn((value) => !value);
    },
    toggleCamera,
    toggleSharing: async () => {
      setSharing((value) => !value);
    },
    addSharing: vi.fn(async () => {}),
    stopVideoTrack: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    cancelRequests: vi.fn(),
    sync: vi.fn(),
    selectedMicrophoneId: microphoneId,
    selectedCameraId: cameraId,
    setMicrophonePreference: setMicrophoneId,
    setCameraPreference: setCameraId,
    selectMicrophone: devices.selectMicrophone,
    selectCamera: devices.selectCamera,
  };
  render(() => (
    <MeetingControls
      collapsed={collapsed()}
      media={media}
      joined
      hasAudio
      playingAudio={false}
      spotlight={false}
      onLeave={onLeave}
      onToggleAudio={onToggleAudio}
      onToggleLayout={onToggleLayout}
      devices={withDevices ? devices : undefined}
    />
  ));
  return {
    setCollapsed,
    media,
    setSharing,
    setCameraBusy,
    setSharingBusy,
    onLeave,
    onToggleAudio,
    onToggleLayout,
    devices,
    setOutputSupported,
    setList,
    setMicrophoneId,
    setOutputId,
    setPermissions,
    setRequesting,
  };
}

describe("meeting control interactions", () => {
  it("requires speaker permission even with a native output picker and a saved output", async () => {
    const { devices, setPermissions, setOutputId } =
      setup(true);
    setOutputId("saved-speaker");
    setPermissions({
      audioinput: "granted",
      audiooutput: "prompt",
      videoinput: "granted",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    );
    const speaker = screen.getByRole("combobox", {
      name: /^meeting\.speaker_device/,
    });
    expect(speaker).toBeDisabled();
    await userEvent.click(speaker);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(devices.selectOutput).not.toHaveBeenCalled();

    setPermissions({
      audioinput: "granted",
      audiooutput: "granted",
      videoinput: "granted",
    });
    expect(speaker).toBeEnabled();
    await chooseDevice(speaker, "speaker-1");
    expect(devices.selectOutput).toHaveBeenLastCalledWith(
      "speaker-1",
    );

    setPermissions({
      audioinput: "granted",
      audiooutput: "denied",
      videoinput: "granted",
    });
    expect(speaker).toBeDisabled();
    expect(devices.selectOutput).toHaveBeenCalledOnce();
  });

  it("disables a default-only speaker selector without a native output picker and enables it when devices become available", async () => {
    const { devices, setList, setPermissions } =
      setup(true);
    devices.access.outputNeedsMicrophone.mockReturnValue(
      true,
    );
    const available = devices.list();
    setList([]);
    setPermissions({
      audioinput: "unavailable",
      audiooutput: "default-only",
      videoinput: "granted",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    );
    const speaker = screen.getByRole("combobox", {
      name: /^meeting\.speaker_device/,
    });
    expect(speaker).toBeDisabled();
    expect(speaker).toHaveTextContent(
      "meeting.default_device",
    );
    await userEvent.click(speaker);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(devices.selectOutput).not.toHaveBeenCalled();

    setList(available);
    setPermissions({
      audioinput: "granted",
      audiooutput: "granted",
      videoinput: "granted",
    });
    expect(speaker).toBeEnabled();
    await chooseDevice(speaker, "speaker-1");
    expect(devices.selectOutput).toHaveBeenLastCalledWith(
      "speaker-1",
    );
  });

  it("allows returning to the default speaker when microphone access cannot unlock output devices", async () => {
    const {
      devices,
      setList,
      setOutputId,
      setPermissions,
    } = setup(true);
    devices.access.outputNeedsMicrophone.mockReturnValue(
      true,
    );
    setList([]);
    setOutputId("removed-speaker");
    setPermissions({
      audioinput: "unavailable",
      audiooutput: "default-only",
      videoinput: "granted",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    );
    const speaker = screen.getByRole("combobox", {
      name: /^meeting\.speaker_device/,
    });
    expect(speaker).toBeEnabled();
    expect(
      screen.getByText("meeting.output_default_only"),
    ).toBeInTheDocument();
    await chooseDevice(speaker as HTMLButtonElement, "");
    expect(devices.selectOutput).toHaveBeenLastCalledWith(
      "",
    );
    expect(devices.outputId()).toBe("");
    expect(speaker).toBeDisabled();
    expect(devices.access.request).not.toHaveBeenCalled();
  });

  it("offers separate microphone and speaker permission actions in the audio menu", () => {
    const { devices, setPermissions } = setup(true);
    setPermissions({
      audioinput: "prompt",
      audiooutput: "prompt",
      videoinput: "granted",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    );
    const microphone = within(
      document.querySelector<HTMLElement>(
        '[data-device-kind="audioinput"]',
      )!,
    );
    const speaker = within(
      document.querySelector<HTMLElement>(
        '[data-device-kind="audiooutput"]',
      )!,
    );
    fireEvent.click(speaker.getByRole("button"));
    expect(devices.access.request).toHaveBeenLastCalledWith(
      "audiooutput",
    );
    fireEvent.click(microphone.getByRole("button"));
    expect(devices.access.request).toHaveBeenLastCalledWith(
      "audioinput",
    );
    setPermissions({
      audioinput: "granted",
      audiooutput: "prompt",
      videoinput: "granted",
    });
    expect(microphone.queryByRole("button")).toBeNull();
    expect(speaker.getByRole("button")).toBeEnabled();
  });

  it("exposes the microphone state and changes the accessible action after toggling", () => {
    setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.enable_microphone",
      }),
    );
    expect(
      screen
        .getByRole("button", {
          name: "meeting.mute_microphone",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.mute_microphone",
      }),
    );
    expect(
      screen
        .getByRole("button", {
          name: "meeting.enable_microphone",
        })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("keeps camera and screen controls independent and allows another share", () => {
    const {
      media,
      setSharing,
      setCameraBusy,
      setSharingBusy,
    } = setup();
    const camera = screen.getByRole("button", {
      name: "meeting.enable_camera",
    }) as HTMLButtonElement;
    setSharing(true);
    expect(camera.disabled).toBe(false);
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.add_sharing",
      }),
    );
    expect(media.addSharing).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("button", {
          name: "meeting.stop_sharing",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    setSharing(false);
    setCameraBusy(true);
    expect(camera.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "meeting.share_screen",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    setCameraBusy(false);
    setSharingBusy(true);
    expect(camera.disabled).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "meeting.share_screen",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    setSharingBusy(false);
    expect(camera.disabled).toBe(false);
  });

  it("routes audio, layout, and explicit room exit to distinct actions", () => {
    const { onLeave, onToggleAudio, onToggleLayout } =
      setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "video.global_unmute",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.focus_layout",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.leave_room",
      }),
    );
    expect(onToggleAudio).toHaveBeenCalledOnce();
    expect(onToggleLayout).toHaveBeenCalledOnce();
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("selects unique devices from separate audio and camera menus and preserves outside/Escape behavior", async () => {
    const {
      devices,
      onToggleAudio,
      setList,
      setCollapsed,
    } = setup(true);
    const audio = screen.getByRole("button", {
      name: "meeting.audio_devices",
    });
    fireEvent.click(audio);
    expect(audio.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(devices.refresh).toHaveBeenCalledOnce();
    const microphone = screen.getByRole("combobox", {
      name: /^meeting\.microphone_device/,
    });
    await userEvent.click(microphone);
    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.dataset.deviceId),
    ).toEqual(["", "communications", "mic-1", "mic-2"]);
    expect(
      screen.getAllByRole("option")[3].textContent,
    ).toBe("meeting.unnamed_microphone");
    // Escape closes the nested select first, leaving the device panel open.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).toBeNull(),
    );
    expect(audio.getAttribute("aria-expanded")).toBe(
      "true",
    );
    await chooseDevice(microphone, "mic-2");
    await chooseDevice(
      screen.getByRole("combobox", {
        name: /^meeting\.speaker_device/,
      }),
      "speaker-1",
    );
    await Promise.resolve();
    expect(devices.selectMicrophone).toHaveBeenCalledWith(
      "mic-2",
    );
    expect(devices.selectOutput).toHaveBeenCalledWith(
      "speaker-1",
    );
    expect(microphone.dataset.deviceId).toBe("mic-2");
    fireEvent.click(
      screen.getByRole("button", {
        name: "video.global_unmute",
      }),
    );
    expect(onToggleAudio).toHaveBeenCalledOnce();
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    fireEvent.keyDown(microphone, { key: "Escape" });
    document.removeEventListener("keydown", bubbled);
    expect(bubbled).not.toHaveBeenCalled();
    expect(audio.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(audio);
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.camera_devices",
      }),
    );
    await chooseDevice(
      screen.getByRole("combobox", {
        name: /^meeting\.camera_device/,
      }),
      "camera-1",
    );
    expect(devices.selectCamera).toHaveBeenCalledWith(
      "camera-1",
    );
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(audio);
    expect(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }).dataset.deviceId,
    ).toBe("mic-2");
    expect(
      screen.getByRole("combobox", {
        name: /^meeting\.speaker_device/,
      }).dataset.deviceId,
    ).toBe("speaker-1");
    setList(
      devices.list().map((device) => ({ ...device })),
    );
    expect(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }).dataset.deviceId,
    ).toBe("mic-2");
    expect(devices.selectMicrophone).toHaveBeenCalledTimes(
      1,
    );
    expect(devices.selectOutput).toHaveBeenCalledTimes(1);
    await chooseDevice(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }),
      "mic-2",
    );
    expect(devices.selectMicrophone).toHaveBeenCalledTimes(
      2,
    );
    // Collapsing also dismisses the open menu and any nested device portal.
    await userEvent.click(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }),
    );
    setCollapsed(true);
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).toBeNull(),
    );
    expect(
      screen.queryByLabelText("meeting.controls"),
    ).toBeNull();
    setCollapsed(false);
    expect(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(devices.selectMicrophone).toHaveBeenCalledTimes(
      2,
    );
  });

  it("keeps the selected value when a device change fails and shows missing capabilities", async () => {
    const {
      devices,
      setOutputSupported,
      setList,
      setMicrophoneId,
    } = setup(true);
    // Controllers report errors through the page toast and leave the selected ID unchanged.
    devices.selectMicrophone.mockImplementation(
      async () => {},
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    );
    const microphone = screen.getByRole("combobox", {
      name: /^meeting\.microphone_device/,
    }) as HTMLButtonElement;
    await chooseDevice(microphone, "mic-2");
    expect(microphone.textContent).toBe(
      "meeting.default_device",
    );
    await Promise.resolve();
    expect(microphone.dataset.deviceId).toBe("");
    setOutputSupported(false);
    setList([]);
    expect(
      screen.getByText("meeting.output_unsupported"),
    ).toBeTruthy();
    expect(
      screen.getByText("meeting.no_microphones"),
    ).toBeTruthy();
    expect(microphone.disabled).toBe(true);
    expect(
      screen.queryByRole("combobox", {
        name: /^meeting\.speaker_device/,
      }),
    ).toBeNull();
    setMicrophoneId("unplugged-microphone");
    expect(microphone.disabled).toBe(false);
    expect(microphone.textContent).toBe(
      "meeting.device_unavailable",
    );
    devices.selectMicrophone.mockImplementation(
      async (id) => {
        setMicrophoneId(id);
      },
    );
    await chooseDevice(microphone, "");
    await Promise.resolve();
    expect(
      devices.selectMicrophone,
    ).toHaveBeenLastCalledWith("");
    expect(microphone.textContent).toBe(
      "meeting.default_device",
    );
  });

  it("requests permissions directly for the active panel and hides denied devices", () => {
    const {
      setPermissions,
      setRequesting,
      setOutputSupported,
      devices,
      media,
    } = setup(true);
    setPermissions({
      audioinput: "prompt",
      audiooutput: "granted",
      videoinput: "granted",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.camera_devices",
      }),
    );
    expect(
      screen.queryByRole("button", {
        name: "meeting.get_permission",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.audio_devices",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.get_permission",
      }),
    );
    expect(devices.access.request).toHaveBeenLastCalledWith(
      "audioinput",
    );
    expect(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }),
    ).toBeTruthy();
    expect(media.microphoneOn()).toBe(false);
    expect(media.cameraOn()).toBe(false);
    setRequesting("audioinput");
    const permission = screen.getByRole("button", {
      name: "meeting.get_permission",
    }) as HTMLButtonElement;
    expect(permission.disabled).toBe(true);
    expect(permission).toHaveTextContent(
      "meeting.get_permission",
    );
    expect(permission).toHaveAttribute("aria-busy", "true");
    fireEvent.click(permission);
    expect(devices.access.request).toHaveBeenCalledTimes(1);
    setPermissions({
      audioinput: "granted",
      audiooutput: "prompt",
      videoinput: "denied",
    });
    setRequesting(null);
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.get_permission",
      }),
    );
    expect(devices.access.request).toHaveBeenLastCalledWith(
      "audiooutput",
    );
    setOutputSupported(false);
    expect(
      screen.queryByRole("button", {
        name: "meeting.get_permission",
      }),
    ).toBeNull();
    setPermissions({
      audioinput: "granted",
      audiooutput: "granted",
      videoinput: "denied",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.camera_devices",
      }),
    );
    expect(
      screen.queryByRole("button", {
        name: "meeting.get_permission",
      }),
    ).toBeNull();
    setPermissions({
      audioinput: "granted",
      audiooutput: "granted",
      videoinput: "prompt",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.get_permission",
      }),
    );
    expect(devices.access.request).toHaveBeenLastCalledWith(
      "videoinput",
    );
  });
});
