import type { StreamAudioSource } from "@/libs/domain/protocol/messages";
import type { RemoteMediaTrackBinding } from "@/libs/domain/session-media";

export interface RemoteAudioSources {
  audioSources?: readonly StreamAudioSource[];
  audioTracks?: readonly RemoteMediaTrackBinding[];
  videoTracks?: readonly RemoteMediaTrackBinding[];
}

/** MID is the shared identity; received track IDs may differ from capture IDs. */
export function getRemoteAudioVideoTrackId(
  trackId: string,
  metadata: RemoteAudioSources,
): string | undefined {
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
