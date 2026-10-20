import { createVideoPresentationStats } from "@/libs/domain/video-presentation-stats";
/** Read-only player observers, owned by the application diagnostics service. */
export class PresentationDiagnostics {
  private readonly disposers = new Set<() => void>();
  private readonly readers = new Map<
    MediaStreamTrack,
    Set<() => Record<string, unknown>>
  >();
  watch(
    track: MediaStreamTrack,
    video: HTMLVideoElement,
  ): () => void {
    const sampler = createVideoPresentationStats(video);
    const read = () => {
      const quality = video.getVideoPlaybackQuality?.();
      return {
        ...sampler.read(),
        paused: video.paused,
        readyState: video.readyState,
        networkState: video.networkState,
        currentTime: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
        errorCode: video.error?.code ?? null,
        totalFrames: quality?.totalVideoFrames,
        droppedFrames: quality?.droppedVideoFrames,
      };
    };
    let readers = this.readers.get(track);
    if (!readers) {
      readers = new Set();
      this.readers.set(track, readers);
    }
    readers.add(read);
    const dispose = () => {
      this.disposers.delete(dispose);
      sampler.close();
      readers.delete(read);
      if (!readers.size) this.readers.delete(track);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  read(track: MediaStreamTrack): Record<string, unknown>[] {
    return [...(this.readers.get(track) ?? [])].map(
      (read) => read(),
    );
  }
  clear(): void {
    for (const dispose of [...this.disposers]) dispose();
    this.readers.clear();
  }
}
