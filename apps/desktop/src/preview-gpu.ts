import type { NativeScreenPreview } from "@weblink/platform";
import type { NativePresentation } from "./presentation";

export async function createGpuPreview(
  presentation: NativePresentation,
  sessionId: string,
  audio: boolean,
  onEnded: () => void,
  signal?: AbortSignal,
): Promise<NativeScreenPreview> {
  signal?.throwIfAborted();
  let audioContext: AudioContext | undefined;
  const surface = presentation.create(
    sessionId,
    true,
    () => {},
    onEnded,
    (error) => {
      console.error(error);
      close();
      onEnded();
    },
  );
  const close = () => {
    signal?.removeEventListener("abort", close);
    surface.close();
    for (const track of surface.stream.getAudioTracks())
      track.stop();
    void audioContext?.close();
  };
  signal?.addEventListener("abort", close, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await surface.open();
    await Promise.race([
      surface.ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Native GPU preview timed out"),
            ),
          10000,
        );
      }),
    ]);
    signal?.throwIfAborted();
    if (audio) {
      audioContext = new AudioContext();
      surface.stream.addTrack(
        audioContext
          .createMediaStreamDestination()
          .stream.getAudioTracks()[0],
      );
    }
    return {
      stream: surface.stream,
      close,
      stats: () => ({
        id: surface.id,
        timestamp: performance.now(),
        ...surface.size,
        frames: surface.latestStats?.presentedFrames ?? 0,
        implementation: "D3D11 / DirectComposition",
      }),
    };
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
