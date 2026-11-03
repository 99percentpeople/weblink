import type { MediaPublication } from "../media-publication";
export { MediaPublicationSender as NativeScreenSender } from "../media-publication";
export interface NativeScreenPublication extends MediaPublication {
  getRecordingSources?(): readonly import("../encoded-video").EncodedMediaSource[];
  openRecording?(
    signal: AbortSignal,
    ended: (error?: Error) => void,
  ): Promise<{ stream: MediaStream; close(): void }>;
  getPreviewStats?(): Promise<
    import("../video-stats").VideoStatsBatch[]
  >;
  updateVideoSettings?(
    settings: import("@weblink/platform").NativeVideoSettings,
  ): Promise<void>;
  setAudioEnabled?(enabled: boolean): Promise<void>;
}
