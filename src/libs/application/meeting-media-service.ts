import { createSignal } from "solid-js";

export interface MeetingMediaPort {
  stream(): MediaStream | null;
  replace(stream: MediaStream | null): void;
  clear(): void;
  getUserMedia(
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream>;
  getDisplayMedia(): Promise<MediaStream>;
}

// Capture identity survives route disposal without cloning the source track.
const screenTracks = new WeakSet<MediaStreamTrack>();
const screenAudioOwners = new WeakMap<
  MediaStreamTrack,
  MediaStreamTrack
>();
const selectedDevices = new WeakMap<
  MediaStreamTrack,
  string
>();
const live = (track: MediaStreamTrack) =>
  track.readyState !== "ended";
const microphone = (track: MediaStreamTrack) =>
  track.kind === "audio" &&
  !screenAudioOwners.has(track) &&
  track.contentHint !== "music";

export function getMeetingVideoSourceKind(
  track: MediaStreamTrack,
): "camera" | "screen" {
  return screenTracks.has(track) ||
    Boolean(track.getSettings().displaySurface)
    ? "screen"
    : "camera";
}

const camera = (track: MediaStreamTrack) =>
  track.kind === "video" &&
  getMeetingVideoSourceKind(track) === "camera";
const screen = (track: MediaStreamTrack) =>
  track.kind === "video" &&
  getMeetingVideoSourceKind(track) === "screen";

const displayAudio = (tracks: MediaStreamTrack[]) =>
  tracks.filter((track) => {
    const owner = screenAudioOwners.get(track);
    return (
      live(track) &&
      owner &&
      live(owner) &&
      tracks.includes(owner)
    );
  });

/** Owns application capture requests and preserves each published source. */
export function createMeetingMediaController(
  port: MeetingMediaPort,
) {
  const currentMicrophones = () =>
    port
      .stream()
      ?.getTracks()
      .filter(
        (track) => microphone(track) && live(track),
      ) ?? [];
  const currentCameras = () =>
    port
      .stream()
      ?.getVideoTracks()
      .filter((track) => camera(track) && live(track)) ??
    [];
  const preference = (
    track: MediaStreamTrack | undefined,
  ) => {
    const id = track
      ? (selectedDevices.get(track) ??
        track.getSettings().deviceId ??
        "")
      : "";
    return id === "default" ? "" : id;
  };
  const [selectedMicrophoneId, setSelectedMicrophoneId] =
    createSignal(preference(currentMicrophones()[0]));
  const [selectedCameraId, setSelectedCameraId] =
    createSignal(preference(currentCameras()[0]));
  const [microphoneOn, setMicrophoneOn] =
    createSignal(false);
  const [audioAvailable, setAudioAvailable] =
    createSignal(false);
  const [audioOn, setAudioOn] = createSignal(false);
  const [cameraOn, setCameraOn] = createSignal(false);
  const [sharing, setSharing] = createSignal(false);
  const [sharingAudioAvailable, setSharingAudioAvailable] =
    createSignal(false);
  const [sharingAudioOn, setSharingAudioOn] =
    createSignal(false);
  const [microphoneBusy, setMicrophoneBusy] =
    createSignal(false);
  const [cameraBusy, setCameraBusy] = createSignal(false);
  const [sharingBusy, setSharingBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(
    null,
  );
  let microphoneRequest = 0;
  let cameraRequest = 0;
  let sharingRequest = 0;
  let sharingAudioEnabled = true;
  let microphonePreferencePending = false;
  let cameraPreferencePending = false;
  let disposed = false;
  let observedStream: MediaStream | null = null;
  let listeners = new AbortController();

  const stop = (stream: MediaStream) =>
    stream.getTracks().forEach((track) => track.stop());
  const report = (cause: unknown) => {
    setError(
      cause instanceof Error
        ? cause.message
        : String(cause),
    );
  };

  const updateState = () => {
    const tracks =
      port.stream()?.getTracks().filter(live) ?? [];
    const liveAudio = tracks.filter(
      (track) => track.kind === "audio",
    );
    setAudioAvailable(liveAudio.length > 0);
    setAudioOn(liveAudio.some((track) => track.enabled));
    setMicrophoneOn(
      tracks.some(
        (track) => microphone(track) && track.enabled,
      ),
    );
    setCameraOn(
      tracks.some(
        (track) => camera(track) && track.enabled,
      ),
    );
    setSharing(tracks.some(screen));
    const audio = displayAudio(tracks);
    const audioOn = audio.some((track) => track.enabled);
    setSharingAudioAvailable(audio.length > 0);
    setSharingAudioOn(audioOn);
    if (audio.length) sharingAudioEnabled = audioOn;
    else if (!tracks.some(screen))
      sharingAudioEnabled = true;
  };

  const observe = (stream: MediaStream | null) => {
    if (observedStream === stream) return;
    listeners.abort();
    listeners = new AbortController();
    observedStream = stream;
    stream?.getTracks().forEach((track) => {
      track.addEventListener(
        "ended",
        () => {
          if (disposed || observedStream !== stream) return;
          publish((candidate) => candidate !== track);
        },
        {
          once: true,
          capture: true,
          signal: listeners.signal,
        },
      );
    });
  };

  const sync = () => {
    if (disposed) return;
    observe(port.stream());
    updateState();
    // Other application capture entry points can replace the live sources.
    // A settings preference can intentionally differ from the live source.
    const microphoneTrack = currentMicrophones()[0];
    const cameraTrack = currentCameras()[0];
    if (microphoneTrack && !microphonePreferencePending)
      setSelectedMicrophoneId(preference(microphoneTrack));
    if (cameraTrack && !cameraPreferencePending)
      setSelectedCameraId(preference(cameraTrack));
  };

  const publish = (
    keep: (track: MediaStreamTrack) => boolean,
    incoming: MediaStreamTrack[] = [],
  ) => {
    const retained = (
      port.stream()?.getTracks() ?? []
    ).filter((track) => live(track) && keep(track));
    const candidates = [...retained, ...incoming];
    // A display's audio shares its lifetime, including native "Stop sharing".
    // Audio ending on its own must not stop the corresponding picture.
    const tracks = candidates.filter((track) => {
      const owner = screenAudioOwners.get(track);
      return !owner || candidates.includes(owner);
    });
    const next = tracks.length
      ? new MediaStream(tracks)
      : null;
    observe(next);
    port.replace(next);
    updateState();
  };

  const deviceConstraints = (
    id: string,
  ): boolean | MediaTrackConstraints =>
    id ? { deviceId: { exact: id } } : true;

  // Settings only choose the next device. Cancel stale requests without
  // opening, stopping or muting any already-published track.
  const setMicrophonePreference = (deviceId: string) => {
    if (disposed) return;
    ++microphoneRequest;
    setMicrophoneBusy(false);
    const track = currentMicrophones()[0];
    microphonePreferencePending =
      !track || preference(track) !== deviceId;
    setSelectedMicrophoneId(deviceId);
  };
  const setCameraPreference = (deviceId: string) => {
    if (disposed) return;
    ++cameraRequest;
    setCameraBusy(false);
    const track = currentCameras()[0];
    cameraPreferencePending =
      !track || preference(track) !== deviceId;
    setSelectedCameraId(deviceId);
  };

  const captureMicrophone = async (
    deviceId: string,
    enabled: boolean,
  ) => {
    const request = ++microphoneRequest;
    setMicrophoneBusy(true);
    try {
      const captured = await port.getUserMedia({
        audio: deviceConstraints(deviceId),
        video: false,
      });
      if (disposed || request !== microphoneRequest) {
        stop(captured);
        return;
      }
      const audio = captured.getAudioTracks().filter(live);
      captured
        .getTracks()
        .filter((track) => !audio.includes(track))
        .forEach((track) => track.stop());
      audio.forEach((track) => {
        track.contentHint = "speech";
        track.enabled = enabled;
        selectedDevices.set(track, deviceId);
      });
      if (!audio.length)
        throw new Error("No microphone track was provided");
      microphonePreferencePending = false;
      publish((track) => !microphone(track), audio);
      setSelectedMicrophoneId(deviceId);
    } catch (cause) {
      if (!disposed && request === microphoneRequest)
        report(cause);
    } finally {
      if (request === microphoneRequest)
        setMicrophoneBusy(false);
    }
  };

  const toggleMicrophone = async () => {
    if (disposed || microphoneBusy()) return;
    setError(null);
    const tracks = currentMicrophones();
    if (tracks.length) {
      const enabled = !tracks.some(
        (track) => track.enabled,
      );
      if (
        enabled &&
        preference(tracks[0]) !== selectedMicrophoneId()
      ) {
        await captureMicrophone(
          selectedMicrophoneId(),
          true,
        );
        return;
      }
      tracks.forEach((track) => {
        track.enabled = enabled;
      });
      updateState();
      return;
    }
    await captureMicrophone(selectedMicrophoneId(), true);
  };

  const selectMicrophone = async (deviceId: string) => {
    if (disposed) return;
    setError(null);
    const tracks = currentMicrophones();
    if (
      !tracks.length ||
      deviceId === preference(tracks[0])
    ) {
      // A preference change while still off must not publish an older pending
      // capture. Re-selecting the active device also cancels a pending switch.
      setMicrophonePreference(deviceId);
      return;
    }
    await captureMicrophone(
      deviceId,
      tracks.some((track) => track.enabled),
    );
  };

  const captureCamera = async (
    deviceId: string,
    enabled = true,
  ) => {
    const request = ++cameraRequest;
    setCameraBusy(true);
    try {
      const captured = await port.getUserMedia({
        audio: false,
        video: deviceConstraints(deviceId),
      });
      if (disposed || request !== cameraRequest) {
        stop(captured);
        return;
      }
      const video = captured.getVideoTracks().find(live);
      captured
        .getTracks()
        .filter((track) => track !== video)
        .forEach((track) => track.stop());
      if (!video)
        throw new Error("No camera track was provided");
      video.enabled = enabled;
      selectedDevices.set(video, deviceId);
      cameraPreferencePending = false;
      publish((track) => !camera(track), [video]);
      setSelectedCameraId(deviceId);
    } catch (cause) {
      if (!disposed && request === cameraRequest)
        report(cause);
    } finally {
      if (request === cameraRequest) setCameraBusy(false);
    }
  };

  const toggleCamera = async () => {
    if (disposed || cameraBusy()) return;
    setError(null);
    if (currentCameras().some((track) => track.enabled)) {
      ++cameraRequest;
      publish((track) => !camera(track));
      return;
    }
    await captureCamera(selectedCameraId());
  };

  const selectCamera = async (deviceId: string) => {
    if (disposed) return;
    setError(null);
    const tracks = currentCameras();
    if (
      !tracks.length ||
      deviceId === preference(tracks[0])
    ) {
      setCameraPreference(deviceId);
      return;
    }
    await captureCamera(
      deviceId,
      tracks.some((track) => track.enabled),
    );
  };

  const setAudioEnabled = (enabled: boolean) => {
    if (disposed) return;
    for (const track of port.stream()?.getAudioTracks() ??
      []) {
      if (live(track)) track.enabled = enabled;
    }
    updateState();
  };

  const setSharingAudioEnabled = (enabled: boolean) => {
    if (disposed) return;
    const audio = displayAudio(
      port.stream()?.getTracks() ?? [],
    );
    if (!audio.length) return;
    sharingAudioEnabled = enabled;
    audio.forEach((track) => {
      track.enabled = enabled;
    });
    updateState();
  };

  const addSharing = async () => {
    if (disposed || sharingBusy()) return;
    setError(null);
    const request = ++sharingRequest;
    setSharingBusy(true);
    try {
      const captured = await port.getDisplayMedia();
      if (disposed || request !== sharingRequest) {
        stop(captured);
        return;
      }
      const video = captured.getVideoTracks().find(live);
      if (!video) {
        stop(captured);
        throw new Error("No screen track was provided");
      }
      const audio = captured.getAudioTracks().filter(live);
      captured
        .getTracks()
        .filter(
          (track) =>
            track !== video && !audio.includes(track),
        )
        .forEach((track) => track.stop());
      screenTracks.add(video);
      audio.forEach((track) => {
        track.contentHint = "music";
        // Adding another display must not undo a user's shared-audio mute.
        track.enabled =
          track.enabled && sharingAudioEnabled;
        screenAudioOwners.set(track, video);
      });
      publish(() => true, [video, ...audio]);
    } catch (cause) {
      if (!disposed && request === sharingRequest)
        report(cause);
    } finally {
      if (request === sharingRequest) setSharingBusy(false);
    }
  };

  const toggleSharing = async () => {
    if (disposed) return;
    if (
      port
        .stream()
        ?.getVideoTracks()
        .some((track) => screen(track) && live(track))
    ) {
      ++sharingRequest;
      setSharingBusy(false);
      setError(null);
      publish((track) => !screen(track));
      return;
    }
    await addSharing();
  };

  const stopVideoTrack = (trackId: string) => {
    if (disposed) return;
    if (
      !port
        .stream()
        ?.getVideoTracks()
        .some((track) => track.id === trackId)
    )
      return;
    if (
      currentCameras().some((track) => track.id === trackId)
    ) {
      ++cameraRequest;
      setCameraBusy(false);
    }
    publish(
      (track) =>
        track.kind !== "video" || track.id !== trackId,
    );
  };

  const cancelRequests = () => {
    ++microphoneRequest;
    ++cameraRequest;
    ++sharingRequest;
    setMicrophoneBusy(false);
    setCameraBusy(false);
    setSharingBusy(false);
  };
  const clear = () => {
    cancelRequests();
    observe(null);
    port.clear();
    updateState();
  };
  const dispose = () => {
    disposed = true;
    cancelRequests();
    listeners.abort();
  };

  sync();
  return {
    microphoneOn,
    audioAvailable,
    audioOn,
    setAudioEnabled,
    cameraOn,
    sharing,
    sharingAudioAvailable,
    sharingAudioOn,
    setSharingAudioEnabled,
    microphoneBusy,
    cameraBusy,
    sharingBusy,
    videoBusy: () => cameraBusy() || sharingBusy(),
    error,
    sync,
    selectedMicrophoneId,
    selectedCameraId,
    setMicrophonePreference,
    setCameraPreference,
    selectMicrophone,
    selectCamera,
    toggleMicrophone,
    toggleCamera,
    toggleSharing,
    addSharing,
    stopVideoTrack,
    clear,
    cancelRequests,
    dispose,
  };
}
