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

export interface RoomTrackEvent extends Event {
  readonly track: MediaStreamTrack;
  readonly streams: readonly MediaStream[];
  readonly receiver: RoomReceiver;
  readonly transceiver: RoomTransceiver;
  /** Original MSIDs when the displayed tracks are backed by a native surface. */
  readonly roomStreamIds?: readonly string[];
}
type RoomEvents = Pick<
  RTCPeerConnectionEventMap,
  | "icecandidate"
  | "datachannel"
  | "connectionstatechange"
  | "iceconnectionstatechange"
  | "signalingstatechange"
  | "negotiationneeded"
> & { track: RoomTrackEvent; error: Event };

export type RoomConfiguration = Pick<
  RTCConfiguration,
  "iceServers" | "iceTransportPolicy"
>;
export type RoomDescription = {
  type: "offer" | "answer";
  sdp: string;
};
export type RoomChannelOptions = Pick<
  RTCDataChannelInit,
  | "ordered"
  | "protocol"
  | "maxRetransmits"
  | "maxPacketLifeTime"
> & { negotiated?: false; id?: never };

/** The WebRTC surface used by a room session on either platform. */
export interface RoomConnection extends Pick<
  RTCPeerConnection,
  | "connectionState"
  | "iceConnectionState"
  | "signalingState"
  | "localDescription"
  | "remoteDescription"
  | "currentRemoteDescription"
  | "dispatchEvent"
  | "close"
> {
  addEventListener<K extends keyof RoomEvents>(
    type: K,
    listener: (event: RoomEvents[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof RoomEvents>(
    type: K,
    listener: (event: RoomEvents[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  readonly screenTransport?: RoomScreenTransport;
  getConfiguration(): RoomConfiguration;
  setConfiguration(config: RoomConfiguration): void;
  /** Generate and apply the offer or answer for the current signaling state. */
  setLocalDescription(): Promise<void>;
  setRemoteDescription(
    description: RoomDescription,
  ): Promise<void>;
  addIceCandidate(
    candidate: RTCIceCandidateInit,
  ): Promise<void>;
  getStats(): Promise<RTCStatsReport>;
  createDataChannel(
    label: string,
    options?: RoomChannelOptions,
  ): RTCDataChannel;
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
  /** Returns whether the optional input channels were attached to this screen. */
  attachScreen(
    capture: string,
    transport: string,
    codecs: NativeSendCodecs,
    control?: NativeControlContext,
  ): Promise<boolean>;
  detachScreen(transport: string): Promise<void>;
  screenReady(transport: string): Promise<void>;
}
type CreateRoomConnection<T extends RoomConnection> = (
  config: RoomConfiguration,
  remoteId: string,
) => T;
export type RoomTransport =
  | {
      readonly kind: "browser";
      create: CreateRoomConnection<RoomConnection>;
    }
  | {
      readonly kind: "native";
      create: CreateRoomConnection<
        RoomConnection & {
          readonly screenTransport: RoomScreenTransport;
        }
      >;
    };

export const browserRoomTransport: RoomTransport = {
  kind: "browser",
  create: (config) => new RTCPeerConnection(config),
};
