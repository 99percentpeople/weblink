import {
  batch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import type { MeetingDeviceAccessState } from "@/libs/domain/meeting-devices";

const kinds = [
  "audioinput",
  "videoinput",
  "audiooutput",
] as const;
const permissionNames = {
  audioinput: "microphone",
  videoinput: "camera",
  audiooutput: "speaker-selection",
} as const;
type OutputDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};
type AccessResults = Record<
  MediaDeviceKind,
  MeetingDeviceAccessState
>;

/** Inspect access without capture. Only an explicit request acquires temporary tracks. */
export function createMediaDeviceAccess(options: {
  devices: Accessor<readonly MediaDeviceInfo[]>;
  refreshing: Accessor<boolean>;
  refresh(): Promise<void>;
  outputSupported: Accessor<boolean>;
}) {
  const [permissions, setPermissions] = createSignal<
    Partial<Record<MediaDeviceKind, PermissionState>>
  >({});
  const [faults, setFaults] = createSignal<
    Partial<
      Record<MediaDeviceKind, "denied" | "unavailable">
    >
  >({});
  const [checked, setChecked] = createSignal(false);
  const [requesting, setRequesting] =
    createSignal<MediaDeviceKind | null>(null);
  const [error, setError] = createSignal<Error | null>(
    null,
  );
  const [selectedOutput, setSelectedOutput] =
    createSignal<MediaDeviceInfo>();
  let disposed = false;
  let generation = 0;
  const listeners = new Map<
    MediaDeviceKind,
    AbortController
  >();
  const outputDevices = () =>
    navigator.mediaDevices as OutputDevices | undefined;
  const outputNeedsMicrophone = () =>
    !outputDevices()?.selectAudioOutput;
  const devices = () => {
    const selected = selectedOutput();
    const list = options.devices();
    return selected &&
      !list.some(
        (device) =>
          device.kind === "audiooutput" &&
          device.deviceId === selected.deviceId,
      )
      ? [...list, selected]
      : list;
  };
  const clearFault = (kind: MediaDeviceKind) =>
    setFaults((previous) => ({
      ...previous,
      [kind]: undefined,
    }));

  const readPermissions = async () => {
    const current = ++generation;
    await Promise.all(
      kinds.map(async (kind) => {
        try {
          const status = await navigator.permissions?.query(
            {
              name: permissionNames[kind] as PermissionName,
            },
          );
          if (disposed || current !== generation || !status)
            return;
          listeners.get(kind)?.abort();
          const controller = new AbortController();
          listeners.set(kind, controller);
          const update = () => {
            setPermissions((previous) => ({
              ...previous,
              [kind]: status.state,
            }));
          };
          update();
          status.addEventListener(
            "change",
            () => {
              clearFault(kind);
              if (
                kind === "audiooutput" &&
                status.state !== "granted"
              )
                setSelectedOutput(undefined);
              update();
              void options.refresh();
            },
            { signal: controller.signal },
          );
        } catch {
          // Some browsers implement capture but not these permission descriptors.
          // Exposed device labels and explicit capture results remain usable evidence.
        }
      }),
    );
    if (!disposed && current === generation)
      setChecked(true);
  };

  const inspectState = (
    kind: MediaDeviceKind,
    previous: AccessResults | undefined,
  ): MeetingDeviceAccessState => {
    const media = outputDevices();
    if (
      window.isSecureContext === false ||
      !media?.enumerateDevices ||
      (kind === "audiooutput"
        ? !options.outputSupported()
        : !media.getUserMedia)
    )
      return "unsupported";
    if (
      permissions()[kind] === "denied" ||
      faults()[kind] === "denied"
    )
      return "denied";
    if (faults()[kind] === "unavailable")
      return "unavailable";
    if (
      devices().some(
        (device) =>
          device.kind === kind &&
          device.deviceId &&
          device.label,
      )
    )
      return "granted";
    if (!checked() || options.refreshing())
      return previous?.[kind] ?? "checking";
    if (kind === "audiooutput" && outputNeedsMicrophone()) {
      const input = inspectState("audioinput", previous);
      if (
        input === "denied" ||
        input === "unsupported" ||
        input === "unavailable" ||
        !devices().some(
          (device) => device.kind === "audioinput",
        )
      )
        return "default-only";
      if (input === "granted") return "unavailable";
    }
    if (
      permissions()[kind] === "granted" &&
      !devices().some((device) => device.kind === kind)
    )
      return "unavailable";
    return "prompt";
  };

  // All permission entry points share these results. A background refresh
  // must not replace a known result with a temporary loading state.
  const results = createMemo<AccessResults>((previous) => ({
    audioinput: inspectState("audioinput", previous),
    videoinput: inspectState("videoinput", previous),
    audiooutput: inspectState("audiooutput", previous),
  }));
  const state = (kind: MediaDeviceKind) => results()[kind];

  const refresh = async () => {
    if (disposed) return;
    await batch(() => {
      setFaults({});
      // A past picker result must not hide a later revocation or unplugged output.
      setSelectedOutput(undefined);
      return Promise.all([
        readPermissions(),
        options.refresh(),
      ]);
    });
  };

  const captureForPermission = async (
    kind: "audioinput" | "videoinput",
  ) => {
    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: kind === "audioinput",
        video: kind === "videoinput",
      });
    try {
      // Enumerate while permission is active, including browsers with one-time grants.
      if (!disposed) await options.refresh();
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  };

  const request = async (
    kind: MediaDeviceKind,
  ): Promise<MediaDeviceInfo | undefined> => {
    if (
      disposed ||
      requesting() ||
      state(kind) === "unsupported" ||
      state(kind) === "default-only"
    )
      return;
    setRequesting(kind);
    setError(null);
    clearFault(kind);
    const captureKind =
      kind === "videoinput" ? "videoinput" : "audioinput";
    const nativeOutput =
      kind === "audiooutput" && !outputNeedsMicrophone();
    try {
      let selected: MediaDeviceInfo | undefined;
      if (nativeOutput) {
        // Call before any await to preserve the click's transient user activation.
        selected =
          await outputDevices()!.selectAudioOutput!();
        if (disposed) return;
        setSelectedOutput(selected);
        await options.refresh();
      } else {
        await captureForPermission(captureKind);
        if (disposed) return;
        clearFault(captureKind);
      }
      await readPermissions();
      return disposed ? undefined : selected;
    } catch (cause) {
      if (disposed) return;
      await readPermissions();
      if (disposed) return;
      const failure =
        cause instanceof Error ||
        cause instanceof DOMException
          ? cause
          : new Error(String(cause));
      const affected = nativeOutput ? kind : captureKind;
      if (
        failure.name === "NotAllowedError" ||
        failure.name === "SecurityError"
      ) {
        // Dismissing a prompt may leave permission at "prompt"; allow retry then.
        if (
          permissions()[affected] !== "prompt" ||
          failure.name === "SecurityError"
        )
          setFaults((previous) => ({
            ...previous,
            [affected]: "denied",
          }));
      } else if (failure.name === "NotFoundError") {
        setFaults((previous) => ({
          ...previous,
          [affected]: "unavailable",
        }));
        // Without a native output picker, the failed capture is a microphone
        // probe, not evidence that the system's speaker is missing.
        if (kind === "audiooutput" && !nativeOutput) return;
      }
      setError(failure);
    } finally {
      if (!disposed) setRequesting(null);
    }
  };

  onMount(() => {
    void readPermissions();
    const controller = new AbortController();
    window.addEventListener("focus", () => void refresh(), {
      signal: controller.signal,
    });
    onCleanup(() => controller.abort());
  });
  onCleanup(() => {
    disposed = true;
    ++generation;
    listeners.forEach((controller) => controller.abort());
  });
  return {
    devices,
    state,
    requesting,
    error,
    refresh,
    request,
    outputNeedsMicrophone,
    needsPermission: () =>
      kinds.some((kind) => state(kind) === "prompt"),
  };
}
