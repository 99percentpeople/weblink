import { getNativeScreenAudioOwner } from "@/libs/domain/native-screen/tracks";
import type { StreamAudioSource } from "@/libs/domain/protocol/messages";
import type { RemoteMediaTrackBinding } from "@/libs/domain/session-media";

export interface RemoteAudioSources {
  nativeScreenStream?: MediaStream;
  audioSources?: readonly StreamAudioSource[];
  audioTracks?: readonly RemoteMediaTrackBinding[];
  videoTracks?: readonly RemoteMediaTrackBinding[];
}

/** MID is the shared identity; received track IDs may differ from capture IDs. */
export function getRemoteAudioVideoTrackId(
  trackId: string,
  metadata: RemoteAudioSources,
): string | undefined {
  const nativeAudio = metadata.nativeScreenStream
    ?.getAudioTracks()
    .find((track) => track.id === trackId);
  if (nativeAudio) {
    const owner = getNativeScreenAudioOwner(nativeAudio);
    if (owner === null) return;
    const videos =
      metadata.nativeScreenStream!.getVideoTracks();
    return (
      owner?.id ??
      (videos.length === 1 ? videos[0].id : undefined)
    );
  }
  const mid = metadata.audioTracks?.find(
    (binding) => binding.trackId === trackId,
  )?.mid;
  const source = metadata.audioSources?.find(
    (source) => source.mid === mid,
  );
  return source?.kind === "screen"
    ? metadata.videoTracks?.find(
        (binding) => binding.mid === source.videoMid,
      )?.trackId
    : undefined;
}

/** The microphone keeps its controls when the camera/avatar presentation changes. */
export function meetingAudioSourceId(
  participantId: string,
  videoTrackId?: string,
): string {
  return JSON.stringify([
    participantId,
    videoTrackId ?? null,
  ]);
}
