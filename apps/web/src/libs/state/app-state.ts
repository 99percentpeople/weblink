import { createStore } from "solid-js/store";
import type {
  InputDeviceSnapshot,
  RuntimeCapabilities,
} from "@weblink/platform";
import type { FileMetaData } from "@/libs/domain/file";
import type { FileTransferStates } from "@/libs/application/transfer/file-transfer-state";
import type {
  Client,
  TransferClient,
} from "@/libs/domain/client";
import type {
  ClientID,
  FileID,
  RoomID,
} from "@/libs/domain/ids";
import type { PeerSession } from "@/libs/domain/session";
import type { RemoteMediaTrackBinding } from "@/libs/domain/session-media";
import type { NativeScreenView } from "@/libs/domain/native-screen/errors";
import type { ClientProfile } from "@/libs/domain/profile";
import type { StoreMessage } from "@/libs/domain/message";
import type {
  Conversation,
  ConversationLabel,
} from "@/libs/domain/conversation";
import type {
  SendClipboardMessage,
  StreamVideoSource,
  StreamAudioSource,
} from "@/libs/domain/protocol/messages";
import type { ChunkCache } from "@/libs/domain/file";
import type { AppOption } from "@/libs/state/app-options";
import { getDefaultAppOptions } from "@/libs/state/app-options";
import { isMobileInputDevice } from "@/libs/domain/remote-control/local-input";

export type ClientServiceStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export type RoomStatus = {
  roomId: RoomID | null;
  profile: TransferClient | null;
  /** Start of this local room session, independent of mounted views. */
  joinedAt: number | null;
};

export interface ClientInfo extends TransferClient {
  candidateType?: string;
  onlineStatus:
    | "offline"
    | "online"
    | "connecting"
    | "reconnecting";
  streamState?: "placeholder" | "media";
  videoSources?: StreamVideoSource[];
  videoTracks?: RemoteMediaTrackBinding[];
  nativeScreenStream?: MediaStream;
  nativeScreenViews?: NativeScreenView[];
  audioSources?: StreamAudioSource[];
  audioTracks?: RemoteMediaTrackBinding[];
  clipboard?: SendClipboardMessage[];
  messageChannel: boolean;
  stream?: MediaStream;
}

export type CacheStatus = "ready" | "loading";

export interface ClipboardAccessState {
  ready: boolean;
  native: boolean;
  read: boolean;
  write: boolean;
  writeFiles: boolean;
  readPermission: PermissionState | "unknown";
  writePermission: PermissionState | "unknown";
}

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
  if (!raw) return defaults;

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

export interface InputDeviceAccessState {
  supported: boolean;
  ready: boolean;
  refreshing: boolean;
  failed: boolean;
  snapshot: InputDeviceSnapshot | null;
}

export type AppState = {
  capabilities: {
    runtime: RuntimeCapabilities | undefined;
    inputDevices: InputDeviceAccessState;
    localInput: {
      mobile: boolean;
      keyboardObserved: boolean;
      gamepadCount: number;
    };
    clipboard: ClipboardAccessState;
  };
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
    error?: string;
    caches: Record<FileID, ChunkCache>;
    cacheInfo: Record<FileID, FileMetaData>;
  };
  transfer: {
    transfers: FileTransferStates;
  };
  message: {
    status: "initializing" | "ready";
    messages: StoreMessage[];
    clients: Client[];
    conversations: Conversation[];
    labels: ConversationLabel[];
  };
};

export const createInitialAppState = (): AppState => ({
  capabilities: {
    runtime: undefined,
    localInput: {
      mobile: isMobileInputDevice(),
      keyboardObserved: false,
      gamepadCount: 0,
    },
    inputDevices: {
      supported: false,
      ready: false,
      refreshing: false,
      failed: false,
      snapshot: null,
    },
    clipboard: {
      ready: false,
      native: false,
      read: false,
      write: false,
      writeFiles: false,
      readPermission: "unknown",
      writePermission: "unknown",
    },
  },
  media: {
    constraints: loadMediaConstraintsFromSession(
      createDefaultMediaConstraints(),
    ),
  },
  roomStatus: {
    roomId: null,
    profile: null,
    joinedAt: null,
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
    transfers: {},
  },
  message: {
    status: "initializing",
    messages: [],
    clients: [],
    conversations: [],
    labels: [],
  },
});

export const [appState, setAppState] =
  createStore<AppState>(createInitialAppState());
