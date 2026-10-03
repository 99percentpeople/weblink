import {
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  videoStatsValue,
  type VideoStatsBatch,
  type VideoStatsSample,
  type VideoStatsValue,
} from "../domain/video-stats";
import {
  createVideoPresentationStats,
  type VideoPresentationStats,
} from "../domain/video-presentation-stats";

export interface VideoStatisticsRow
  extends VideoStatsValue, VideoPresentationStats {
  direction: "send" | "receive" | "capture" | "display";
  preview?: boolean;
  peer?: string;
  /** Two bounded snapshots preserve drop/loss counters for copied diagnostics. */
  counters?: {
    current: VideoStatsSample;
    previous?: VideoStatsSample;
  };
}

/** A displayed overlay owns its sampler, never its borrowed video/capture. */
export function createVideoStatistics(
  track: Accessor<MediaStreamTrack | null>,
  video: Accessor<HTMLVideoElement | null>,
  read: (
    track: MediaStreamTrack,
  ) => Promise<VideoStatsBatch[]>,
  local: Accessor<boolean> = () => false,
): Accessor<VideoStatisticsRow[]> {
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([]);
  createEffect(() => {
    const current = track();
    const element = video();
    const isLocal = local();
    setRows([]);
    if (!current || !element) return;
    const presentation =
      createVideoPresentationStats(element);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = new Map<
      object | string,
      Map<string, VideoStatsSample>
    >();
    const poll = async () => {
      try {
        if (element.ownerDocument.hidden) {
          previous.clear();
          return;
        }
        if (current.readyState === "ended") {
          presentation.close();
          setRows([]);
          return;
        }
        const batches = await read(current);
        if (stopped) return;
        const next = new Map<
          object | string,
          Map<string, VideoStatsSample>
        >();
        const values: VideoStatisticsRow[] =
          batches.flatMap((batch) => {
            const samples = new Map<
              string,
              VideoStatsSample
            >();
            next.set(batch.key, samples);
            return batch.samples.map((sample) => {
              const before = previous
                .get(batch.key)
                ?.get(sample.id);
              samples.set(sample.id, sample);
              return {
                ...videoStatsValue(sample, before),
                direction: batch.direction,
                preview: batch.preview,
                peer: batch.peer,
                counters: {
                  current: sample,
                  previous: before,
                },
              };
            });
          });
        previous = next;
        const display = presentation.read();
        if (!values.length) {
          values.push({
            ...display,
            direction: "display",
            preview: isLocal,
            width: element.videoWidth || undefined,
            height: element.videoHeight || undefined,
          });
        } else if (
          Object.values(display).some(
            (value) => value !== undefined,
          )
        ) {
          values.push({
            ...display,
            direction: "display",
            preview: isLocal,
          });
        }
        setRows(values);
      } catch {
        // A closed/replaced transport is normal during leave/rejoin.
        if (!stopped) {
          previous.clear();
          setRows([]);
        }
      } finally {
        if (!stopped && current.readyState !== "ended")
          timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    onCleanup(() => {
      stopped = true;
      presentation.close();
      clearTimeout(timer);
      previous.clear();
    });
  });
  return rows;
}
