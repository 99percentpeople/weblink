import type {
  NativeControlContext,
  NativeSendCodecs,
} from "./index";

export type RoomSender = Pick<
  RTCRtpSender,
  "track" | "getStats" | "getParameters" | "setParameters"
>;
export interface RoomReceiver {
  readonly track: MediaStreamTrack | null;
  getStats(): Promise<RTCStatsReport>;
  getSynchronizationSources?: RTCRtpReceiver["getSynchronizationSources"];
}
export interface RoomTransceiver {
  readonly mid: string | null;
  readonly sender: RoomSender;
  readonly receiver: RoomReceiver;
  setCodecPreferences(codecs: RTCRtpCodec[]): void;
}

/** The WebRTC surface used by a room session on either platform. */
export interface RoomConnection extends Pick<
  RTCPeerConnection,
  | "connectionState"
  | "iceConnectionState"
  | "signalingState"
  | "localDescription"
  | "remoteDescription"
  | "currentRemoteDescription"
  | "getConfiguration"
  | "setConfiguration"
  | "setLocalDescription"
  | "setRemoteDescription"
  | "addIceCandidate"
  | "getStats"
  | "addEventListener"
  | "removeEventListener"
  | "dispatchEvent"
  | "createDataChannel"
  | "close"
> {
  readonly sctp: Pick<
    RTCSctpTransport,
    "maxMessageSize"
  > | null;
  getSenders(): RoomSender[];
  getReceivers(): RoomReceiver[];
  getTransceivers(): RoomTransceiver[];
  addTrack(
    track: MediaStreamTrack,
    ...streams: MediaStream[]
  ): RoomSender;
  removeTrack(sender: RoomSender): void;
  /** Native peers create initial receive transceivers in the host. */
  addTransceiver?: RTCPeerConnection["addTransceiver"];
}

/** Additional operations when the platform owns the room's ICE/DTLS transport. */
export interface RoomScreenTransport {
  receiveContent(allowed: boolean): void;
  attachScreen(
    capture: string,
    transport: string,
    codecs: NativeSendCodecs,
    control?: NativeControlContext,
  ): Promise<void>;
  detachScreen(transport: string): Promise<void>;
  screenReady(transport: string): Promise<void>;
}
export interface NativeRoomTransport {
  create(
    config: RTCConfiguration,
    remoteId: string,
  ): RoomConnection & RoomScreenTransport;
}
