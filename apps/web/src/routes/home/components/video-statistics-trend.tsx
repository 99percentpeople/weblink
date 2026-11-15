import { createMemo, Index, Show } from "solid-js";
import { t } from "@/i18n";
import {
  STATISTICS_HISTORY_MS,
  statisticsTrendSegments,
  type StatisticsTrend,
} from "@/libs/hooks/video-statistics-history";
import { formatStatisticsValue } from "./video-statistics-format";

export function VideoStatisticsTrend(props: {
  trend: StatisticsTrend;
  label: string;
}) {
  const chart = createMemo(() => {
    const { samples, key } = props.trend;
    const end = samples.at(-1)?.at ?? 0;
    const segments = statisticsTrendSegments(props.trend);
    const ceiling = Math.max(
      1,
      ...segments.flat().map((sample) => sample[key]!),
    );
    return {
      ceiling,
      segments: segments.map((segment) =>
        segment.map((sample) => ({
          x:
            1 +
            98 *
              (1 -
                (end - sample.at) / STATISTICS_HISTORY_MS),
          y: 22 - (20 * sample[key]!) / ceiling,
        })),
      ),
    };
  });
  const description = () =>
    t("video.statistics.trend", {
      metric: props.label,
      seconds: STATISTICS_HISTORY_MS / 1000,
      maximum: formatStatisticsValue(
        props.trend.key,
        chart().ceiling,
      ),
    });
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={description()}
      class="h-4 w-20 min-w-0 text-sky-300/80"
    >
      <title>{description()}</title>
      <path
        d="M1 22H99"
        fill="none"
        stroke="currentColor"
        stroke-opacity="0.15"
        vector-effect="non-scaling-stroke"
      />
      <Index each={chart().segments}>
        {(segment) => (
          <Show
            when={segment().length > 1}
            fallback={
              <circle
                cx={segment()[0].x}
                cy={segment()[0].y}
                r="1.5"
                fill="currentColor"
              />
            }
          >
            <polyline
              points={segment()
                .map(({ x, y }) => `${x},${y}`)
                .join(" ")}
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </Show>
        )}
      </Index>
    </svg>
  );
}
