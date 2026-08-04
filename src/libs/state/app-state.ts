import { createStore } from "solid-js/store";
import type { FileMetaData } from "@/libs/cache";
import type { FileTransferer } from "@/libs/core/file-transferer";
import type {
  ClientID,
  ClientInfo,
  FileID,
  RoomStatus,
} from "@/libs/core/type";
import type { PeerSession } from "@/libs/core/session";
import type { ClientProfile } from "@/libs/core/profile";
import type { StoreMessage } from "@/libs/core/message";
import type { Client } from "@/libs/core/type";
import type { ChunkCache } from "@/libs/cache/chunk-cache";
import type { AppOption } from "@/libs/state/app-options";
import { getDefaultAppOptions } from "@/libs/state/app-options";

export type ClientServiceStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export type CacheStatus = "ready" | "loading";

export type MicrophoneConstraintsState = {
  autoGainControl?: boolean;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  voiceIsolation?: boolean;
};

export type SpeakerConstraintsState = {
  suppressLocalAudioPlayback?: boolean;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  latency?: ConstrainDouble;
};

export type VideoConstraintsState = {
  frameRate?: ConstrainDouble;
};

export type MediaConstraintsState = {
  microphone: MicrophoneConstraintsState;
  speaker: SpeakerConstraintsState;
  video: VideoConstraintsState;
};

const mediaConstraintsStorageKey = "mediaConstraints";
const legacyMicrophoneConstraintsStorageKey =
  "microphoneConstraints";
const legacySpeakerConstraintsStorageKey =
  "speakerConstraints";
const legacyVideoConstraintsStorageKey = "videoConstraints";

const getSupportedConstraints = () => {
  if (
    typeof navigator === "undefined" ||
    !("mediaDevices" in navigator)
  ) {
    return {};
  }
  return navigator.mediaDevices.getSupportedConstraints();
};

const isObject = (
  value: unknown,
): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const createDefaultMediaConstraints =
  (): MediaConstraintsState => {
    const constraints = getSupportedConstraints();

    return {
      microphone: {
        autoGainControl:
          "autoGainControl" in constraints
            ? true
            : undefined,
        echoCancellation:
          "echoCancellation" in constraints
            ? true
            : undefined,
        noiseSuppression:
          "noiseSuppression" in constraints
            ? true
            : undefined,
        voiceIsolation:
          "voiceIsolation" in constraints
            ? true
            : undefined,
      },
      speaker: {
        suppressLocalAudioPlayback:
          "suppressLocalAudioPlayback" in constraints
            ? false
            : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency:
          "latency" in constraints
            ? { ideal: 0 }
            : undefined,
      },
      video: {
        frameRate: { max: 60 },
      },
    };
  };

const loadMediaConstraintsFromSession = (
  defaults: MediaConstraintsState,
): MediaConstraintsState => {
  if (typeof sessionStorage === "undefined") {
    return defaults;
  }

  const raw = sessionStorage.getItem(
    mediaConstraintsStorageKey,
  );
  if (!raw) {
    return loadLegacyMediaConstraintsFromSession(defaults);
  }

  try {
    const parsed = JSON.parse(
      raw,
    ) as Partial<MediaConstraintsState>;

    const microphone = isObject(parsed.microphone)
      ? (parsed.microphone as Partial<MicrophoneConstraintsState>)
      : {};
    const speaker = isObject(parsed.speaker)
      ? (parsed.speaker as Partial<SpeakerConstraintsState>)
      : {};
    const video = isObject(parsed.video)
      ? (parsed.video as Partial<VideoConstraintsState>)
      : {};

    return {
      microphone: {
        ...defaults.microphone,
        ...microphone,
      },
      speaker: {
        ...defaults.speaker,
        ...speaker,
      },
      video: {
        ...defaults.video,
        ...video,
      },
    };
  } catch (err) {
    console.warn(
      "[AppState] failed to parse media constraints",
      err,
    );
    return defaults;
  }
};

const loadLegacyConstraints = <T extends object>(
  key: string,
): Partial<T> => {
  if (typeof sessionStorage === "undefined") {
    return {};
  }

  const raw = sessionStorage.getItem(key);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
};

const loadLegacyMediaConstraintsFromSession = (
  defaults: MediaConstraintsState,
): MediaConstraintsState => {
  const legacyMicrophone =
    loadLegacyConstraints<MicrophoneConstraintsState>(
      legacyMicrophoneConstraintsStorageKey,
    );
  const legacySpeaker =
    loadLegacyConstraints<SpeakerConstraintsState>(
      legacySpeakerConstraintsStorageKey,
    );
  const legacyVideo =
    loadLegacyConstraints<VideoConstraintsState>(
      legacyVideoConstraintsStorageKey,
    );

  return {
    microphone: {
      ...defaults.microphone,
      ...legacyMicrophone,
    },
    speaker: {
      ...defaults.speaker,
      ...legacySpeaker,
    },
    video: {
      ...defaults.video,
      ...legacyVideo,
    },
  };
};

export const saveMediaConstraintsToSession = (
  constraints: MediaConstraintsState,
) => {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.setItem(
      mediaConstraintsStorageKey,
      JSON.stringify(constraints),
    );
  } catch (err) {
    console.warn(
      "[AppState] failed to persist media constraints",
      err,
    );
  }
};

export type AppState = {
  roomStatus: RoomStatus;
  profile: ClientProfile;
  options: AppOption;
  media: {
    constraints: MediaConstraintsState;
  };
  session: {
    sessions: Record<ClientID, PeerSession>;
    clientViewData: Record<ClientID, ClientInfo>;
    clientServiceStatus: ClientServiceStatus;
    localStream: MediaStream | null;
  };
  cache: {
    status: CacheStatus;
    caches: Record<FileID, ChunkCache>;
    cacheInfo: Record<FileID, FileMetaData>;
  };
  transfer: {
    transferers: Record<FileID, FileTransferer>;
  };
  message: {
    status: "initializing" | "ready";
    messages: StoreMessage[];
    clients: Client[];
  };
};

export const createInitialAppState = (): AppState => ({
  media: {
    constraints: loadMediaConstraintsFromSession(
      createDefaultMediaConstraints(),
    ),
  },
  roomStatus: {
    roomId: null,
    profile: null,
  },
  profile: {
    roomId: "",
    password: null,
    autoJoin: false,
    initalJoin: true,
    clientId: "",
    name: "",
    avatar: null,
  },
  options: getDefaultAppOptions(),
  session: {
    sessions: {},
    clientViewData: {},
    clientServiceStatus: "disconnected",
    localStream: null,
  },
  cache: {
    status: "loading",
    caches: {},
    cacheInfo: {},
  },
  transfer: {
    transferers: {},
  },
  message: {
    status: "initializing",
    messages: [],
    clients: [],
  },
});

export const [appState, setAppState] =
  createStore<AppState>(createInitialAppState());
