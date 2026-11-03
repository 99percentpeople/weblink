/** Native receive connections retain standard SDP/ICE and a UI-facing media stream. */
export interface NativeMediaReceive {
  /** False keeps decode failures and retries on the native receive path. */
  readonly allowBrowserFallback?: boolean;
  /** RTP audio and video MIME types supported by the native receive factory. */
  codecs(): Promise<string[]>;
  open(
    configuration: RTCConfiguration,
    onEvent: (event: NativeReceiveEvent) => void,
    signal: AbortSignal,
    source?: "screen" | "camera",
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
