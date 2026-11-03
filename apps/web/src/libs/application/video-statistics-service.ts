import type { RoomConnection } from "@weblink/platform";
import { getNativeScreenPublication } from "./native-screen-service";
import {
  readBrowserVideoStats,
  type VideoStatsBatch,
} from "../domain/video-stats";
import type { NativeScreenSession } from "../domain/native-screen/session";

export interface VideoStatisticsPeer {
  pc: RoomConnection | null;
  native?: NativeScreenSession;
  camera?: {
    stats(
      track: MediaStreamTrack,
    ): Promise<VideoStatsBatch[]>;
  };
  name?: string;
}

/** UI-facing read API. Diagnostics neither renegotiate nor own media tracks. */
export async function readVideoStatistics(
  track: MediaStreamTrack,
  peers: readonly VideoStatisticsPeer[],
): Promise<VideoStatsBatch[]> {
  if (track.readyState === "ended") return [];
  const publication = getNativeScreenPublication(track);
  const pending: Promise<VideoStatsBatch[]>[] = [];
  if (publication?.getPreviewStats)
    pending.push(publication.getPreviewStats());
  for (const { pc, native, camera, name } of peers) {
    if (camera)
      pending.push(
        camera.stats(track).then((batches) =>
          batches.map((batch) => ({
            ...batch,
            peer: name,
          })),
        ),
      );
    if (native)
      pending.push(
        native
          .getVideoStats(track, publication)
          .then((batches) =>
            batches.map((batch) => ({
              ...batch,
              peer: name,
            })),
          ),
      );
    if (pc && !publication) {
      for (const direction of [
        "send",
        "receive",
      ] as const) {
        pending.push(
          readBrowserVideoStats(pc, track, direction).then(
            (samples) =>
              samples.length
                ? [
                    {
                      key: pc,
                      direction,
                      peer: name,
                      samples,
                    },
                  ]
                : [],
          ),
        );
      }
    }
  }
  // A closing peer cannot hide the other active transports' statistics.
  const results = await Promise.allSettled(pending);
  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}
