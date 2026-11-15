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
import { createVideoPresentationStats } from "../domain/video-presentation-stats";
import type { VideoPresentationStats } from "@weblink/platform";
import { createPresentationVisible } from "./presentation-visible";
import { platform } from "@/libs/platform/runtime";
import {
  appendStatisticsHistory,
  type StatisticsHistoryPoint,
} from "./video-statistics-history";

interface PreviousStatistics {
  sample: VideoStatsSample;
  history: StatisticsHistoryPoint[];
}

export interface VideoStatisticsRow
  extends VideoStatsValue, VideoPresentationStats {
  direction: "send" | "receive" | "capture" | "display";
  preview?: boolean;
  peer?: string;
  history?: readonly StatisticsHistoryPoint[];
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
  const visible = createPresentationVisible(
    () => video()?.ownerDocument,
  );
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([]);
  createEffect(() => {
    const current = track();
    const element = video();
    const isLocal = local();
    setRows([]);
    if (!current || !element || !visible()) return;
    const presentation =
      platform.videoPresentation?.sample?.(current) ??
      createVideoPresentationStats(element);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = new Map<
      object | string,
      Map<string, PreviousStatistics>
    >();
    let displayHistory: StatisticsHistoryPoint[] = [];
    const poll = async () => {
      try {
        if (current.readyState === "ended") {
          presentation.close();
          setRows([]);
          return;
        }
        const batches = await read(current);
        if (stopped) return;
        const at = performance.now();
        const next = new Map<
          object | string,
          Map<string, PreviousStatistics>
        >();
        const values: VideoStatisticsRow[] =
          batches.flatMap((batch) => {
            const samples =
              next.get(batch.key) ??
              new Map<string, PreviousStatistics>();
            next.set(batch.key, samples);
            return batch.samples.map((sample) => {
              const key = JSON.stringify([
                batch.direction,
                batch.preview === true,
                sample.id,
              ]);
              const before = previous
                .get(batch.key)
                ?.get(key);
              const value = videoStatsValue(
                sample,
                before?.sample,
              );
              const history = appendStatisticsHistory(
                before?.sample.codec === sample.codec
                  ? (before?.history ?? [])
                  : [],
                value,
                at,
              );
              samples.set(key, { sample, history });
              return {
                ...value,
                history,
                direction: batch.direction,
                preview: batch.preview,
                peer: batch.peer,
                counters: {
                  current: sample,
                  previous: before?.sample,
                },
              };
            });
          });
        previous = next;
        const display = presentation.read();
        displayHistory = appendStatisticsHistory(
          displayHistory,
          display,
          at,
        );
        if (!values.length) {
          values.push({
            ...display,
            history: displayHistory,
            direction: "display",
            preview: isLocal,
            width: element.videoWidth || undefined,
            height: element.videoHeight || undefined,
          });
        } else if (
          Object.values(display).some(
            (value) => value !== undefined,
          ) ||
          // Retain presentation gaps instead of falling back to decoder FPS.
          displayHistory.some(
            (point) =>
              point.fps !== undefined ||
              point.receiveToPresentMs !== undefined ||
              point.onePercentLowFps !== undefined,
          )
        ) {
          values.push({
            ...display,
            history: displayHistory,
            direction: "display",
            preview: isLocal,
          });
        }
        setRows(values);
      } catch {
        // A closed/replaced transport is normal during leave/rejoin.
        if (!stopped) {
          previous.clear();
          displayHistory = [];
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
      displayHistory = [];
    });
  });
  return rows;
}
