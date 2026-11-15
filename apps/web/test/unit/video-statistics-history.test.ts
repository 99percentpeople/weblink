import { expect, it } from "vitest";
import {
  appendStatisticsHistory,
  statisticsTrendSegments,
  type StatisticsHistoryPoint,
} from "@/libs/hooks/video-statistics-history";

it("retains only the last minute without mutating earlier snapshots", () => {
  let history: StatisticsHistoryPoint[] = [];
  for (let second = 0; second <= 75; second++)
    history = appendStatisticsHistory(
      history,
      { fps: second },
      second * 1000,
    );
  expect(history).toHaveLength(61);
  expect(history[0]).toEqual({ at: 15_000, fps: 15 });
  const next = appendStatisticsHistory(
    history,
    { fps: 0 },
    140_000,
  );
  expect(next).toEqual([{ at: 140_000, fps: 0 }]);
  expect(history.at(-1)).toEqual({ at: 75_000, fps: 75 });
});

it("bounds dense histories and handles repeated or restarted sample clocks", () => {
  let history: StatisticsHistoryPoint[] = [];
  for (let at = 0; at < 1000; at++)
    history = appendStatisticsHistory(
      history,
      { fps: 60 },
      at,
    );
  expect(history).toHaveLength(61);
  history = appendStatisticsHistory(
    history,
    { fps: 59 },
    999,
  );
  expect(history).toHaveLength(61);
  expect(history.at(-1)?.fps).toBe(59);
  expect(
    appendStatisticsHistory(history, { fps: 30 }, 0),
  ).toEqual([{ at: 0, fps: 30 }]);
});

it("stores only valid numeric measurements and preserves missing readings as gaps", () => {
  const value = {
    fps: 0,
    bitrate: Infinity,
    decodeMs: Number.NaN,
    encodeMs: -1,
    counters: { frames: 100 },
    codec: "video/H264",
  };
  const history = appendStatisticsHistory([], value, 1000);
  expect(history).toEqual([{ at: 1000, fps: 0 }]);
  expect(
    appendStatisticsHistory(history, {}, 2000),
  ).toEqual([{ at: 1000, fps: 0 }, { at: 2000 }]);
});

it("breaks lines at unavailable measurements and long sampling gaps", () => {
  const samples: StatisticsHistoryPoint[] = [
    { at: 0, fps: 0 },
    { at: 1000, fps: 60 },
    { at: 2000 },
    { at: 3000, fps: 59 },
    { at: 4000, fps: 60 },
    { at: 8000, fps: 30 },
    { at: 9000, fps: Number.NaN },
    { at: 10_000, fps: 29 },
  ];
  expect(
    statisticsTrendSegments({ key: "fps", samples }).map(
      (segment) => segment.map((point) => point.fps),
    ),
  ).toEqual([[0, 60], [59, 60], [30], [29]]);
});
