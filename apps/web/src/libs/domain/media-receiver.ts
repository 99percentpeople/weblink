import type { VideoStatsSample } from "./video-stats";

export interface MediaReceiveConnection {
  readonly stream: MediaStream;
  /** Audio delivery lag relative to video in seconds, sampled for recording. */
  recordingAudioSkew?(): Promise<number | undefined>;
  answer(sdp: string): Promise<string>;
  addIceCandidate(
    candidate: RTCIceCandidateInit,
  ): Promise<void>;
  connected(audio?: boolean): Promise<void>;
  monitorDecode(healthy: () => void): void;
  decodeFailed(): void;
  close(): void;
  getVideoStats(
    track: MediaStreamTrack,
  ): Promise<VideoStatsSample[]>;
}

export type MediaReceiverFactory = (
  sdp: string,
  configuration: RTCConfiguration,
  changed: (stream: MediaStream | null) => void,
  failed: (error: Error) => void,
  candidate?: (candidate: RTCIceCandidateInit) => void,
) => MediaReceiveConnection;
