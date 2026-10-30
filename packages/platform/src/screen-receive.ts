/** Native receive connections retain standard SDP/ICE and browser presentation. */
export interface NativeScreenReceive {
  codecs(): Promise<string[]>;
  open(
    configuration: RTCConfiguration,
    onEvent: (event: NativeReceiveEvent) => void,
    signal: AbortSignal,
  ): Promise<NativeReceiveConnection>;
}

export type NativeReceiveEvent =
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "state"; state: RTCPeerConnectionState }
  | { type: "error"; error: string }
  | { type: "track" }
  | {
      type: "channel";
      label: string;
      state: RTCDataChannelState;
    }
  | { type: "message"; label: string; data: string };

export interface NativeReceiveConnection {
  readonly stream: MediaStream;
  answer(sdp: string): Promise<string>;
  addIceCandidate(
    candidate: RTCIceCandidateInit,
  ): Promise<void>;
  /** Standard WebRTC report fields, serialized by the native receiver. */
  stats(): Promise<(RTCStats & Record<string, unknown>)[]>;
  send(label: string, data: string): Promise<void>;
  close(): void;
}
