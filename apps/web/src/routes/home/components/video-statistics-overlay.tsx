import {
  createMemo,
  createSignal,
  createUniqueId,
  Index,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  X,
} from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { createFloatingPanel } from "@/libs/hooks/create-floating-panel";
import {
  createVideoStatistics,
  type VideoStatisticsRow,
} from "@/libs/hooks/video-statistics";
import type { VideoStatsBatch } from "@/libs/domain/video-stats";
import { useVideoDisplay } from "@/routes/home/components/video-display-context";
import { copyText } from "@/libs/utils/copy-text";
import {
  formatVideoStatistics,
  statisticsText,
  type StatisticsMetric,
} from "./video-statistics-format";
import { VideoStatisticsTrend } from "./video-statistics-trend";
import { formatVideoStatisticsOverview } from "./video-statistics-overview";

export function VideoStatisticsOverlay(props: {
  local?: boolean;
  mount?: HTMLElement;
  read: (
    track: MediaStreamTrack,
  ) => Promise<VideoStatsBatch[]>;
  onClose?(): void;
}) {
  const { videoRef, videoTrack } = useVideoDisplay();
  const rows = createVideoStatistics(
    videoTrack,
    videoRef,
    props.read,
    () => props.local === true,
  );
  return (
    <Show when={videoTrack()}>
      <Show
        when={props.mount}
        fallback={
          <StatisticsWindow
            rows={rows()}
            onClose={props.onClose}
          />
        }
      >
        <Portal
          mount={props.mount}
          ref={(container) => {
            container.style.display = "contents";
          }}
        >
          <StatisticsWindow
            rows={rows()}
            onClose={props.onClose}
          />
        </Portal>
      </Show>
    </Show>
  );
}

function StatisticsMetrics(props: {
  metrics: StatisticsMetric[];
}) {
  return (
    <dl>
      <Index each={props.metrics}>
        {(metric) => (
          <div
            class="flex min-w-0 items-center gap-2"
            title={metric().description}
          >
            <dt class="min-w-0 flex-1 break-words text-white/50">
              {metric().label}
            </dt>
            <dd
              class="flex w-[10.5rem] max-w-[70%] items-center justify-end gap-2
                font-mono tabular-nums"
              classList={{
                "text-white/85": !metric().secondary,
                "text-white/50": metric().secondary,
              }}
            >
              <Show when={metric().trend}>
                {(trend) => (
                  <VideoStatisticsTrend
                    trend={trend()}
                    label={metric().label}
                  />
                )}
              </Show>
              <span class="w-[12ch] shrink-0 text-right">
                {metric().value}
              </span>
            </dd>
          </div>
        )}
      </Index>
    </dl>
  );
}

function StatisticsWindow(props: {
  rows: VideoStatisticsRow[];
  onClose?(): void;
}) {
  let boundary!: HTMLDivElement;
  let panel!: HTMLElement;
  let handle!: HTMLButtonElement;
  const bodyId = createUniqueId();
  const [expanded, setExpanded] = createSignal(false);
  const floating = createFloatingPanel({
    boundary: () => boundary,
    panel: () => panel,
    handle: () => handle,
  });
  const rows = createMemo(() =>
    props.rows.map(formatVideoStatistics),
  );
  const overview = createMemo(() =>
    formatVideoStatisticsOverview(props.rows),
  );
  const detailLabel = () =>
    t(
      expanded()
        ? "video.statistics.hide_details"
        : "video.statistics.show_details",
    );
  const copy = async () => {
    const text = [
      `${t("video.statistics.title")} · ${new Date().toISOString()}`,
      ...rows().map(statisticsText),
      JSON.stringify(props.rows, null, 2),
    ].join("\n\n");
    if (await copyText(text))
      toast.success(t("common.notification.copy_success"));
  };
  const stop = (event: Event) => event.stopPropagation();
  return (
    <div
      ref={boundary}
      class="pointer-events-none absolute inset-0 z-50"
    >
      <section
        ref={panel}
        role="region"
        aria-label={t("video.statistics.title")}
        data-stream-statistics
        class="pointer-events-auto absolute left-0 top-0 flex
          max-h-[calc(100%-1rem)] w-72 max-w-[calc(100%-1rem)]
          flex-col overflow-hidden rounded-md border border-white/10
          bg-zinc-950/85 text-[10px] leading-4 text-white shadow-md
          backdrop-blur-sm"
        style={{
          transform: `translate3d(${floating.position().x}px, ${floating.position().y}px, 0)`,
        }}
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
        onPointerCancel={stop}
        onClick={stop}
        onDblClick={stop}
        onContextMenu={stop}
        onWheel={stop}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.key === "Escape" &&
            !event.isComposing &&
            props.onClose
          ) {
            event.preventDefault();
            props.onClose();
          }
        }}
        onKeyUp={stop}
      >
        <div class="flex shrink-0 items-center border-b border-white/10 p-0.5">
          <button
            ref={handle}
            type="button"
            aria-label={t("video.statistics.move")}
            title={t("video.statistics.move_hint")}
            class="flex min-w-0 flex-1 touch-none select-none items-center
              gap-1 rounded px-1 py-1 text-left font-medium outline-none
              focus-visible:ring-1 focus-visible:ring-white/60"
            style={{
              cursor: floating.dragging()
                ? "grabbing"
                : "grab",
            }}
          >
            <GripVertical
              class="size-3 shrink-0 text-white/40"
              aria-hidden="true"
            />
            <span class="truncate">
              {t("video.statistics.title")}
            </span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="size-6 rounded text-white/60 hover:bg-white/10
              hover:text-white"
            title={detailLabel()}
            aria-label={detailLabel()}
            aria-expanded={expanded()}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
          >
            <Show
              when={expanded()}
              fallback={
                <ChevronDown
                  class="size-3"
                  aria-hidden="true"
                />
              }
            >
              <ChevronUp
                class="size-3"
                aria-hidden="true"
              />
            </Show>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="size-6 rounded text-white/60 hover:bg-white/10
              hover:text-white"
            title={t("video.statistics.copy")}
            aria-label={t("video.statistics.copy")}
            disabled={!rows().length}
            onClick={() => void copy()}
          >
            <Copy class="size-3" aria-hidden="true" />
          </Button>
          <Show when={props.onClose}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              class="size-6 rounded text-white/60 hover:bg-white/10
                hover:text-white"
              title={t("common.action.close")}
              aria-label={t("common.action.close")}
              onClick={() => props.onClose?.()}
            >
              <X class="size-3" aria-hidden="true" />
            </Button>
          </Show>
        </div>
        <div
          id={bodyId}
          class="min-h-0 overflow-y-auto overscroll-contain"
        >
          <Show
            when={rows().length}
            fallback={
              <p class="px-2 py-2 text-white/50">
                {t("video.statistics.waiting")}
              </p>
            }
          >
            <Show
              when={expanded()}
              fallback={
                <div class="px-2 pb-1.5 pt-1">
                  <StatisticsMetrics metrics={overview()} />
                </div>
              }
            >
              <Index each={rows()}>
                {(row) => (
                  <section
                    aria-label={row().title}
                    class="space-y-1 border-b border-white/10 px-2 py-1.5 last:border-0"
                  >
                    <div class="flex flex-wrap items-baseline justify-between gap-x-2">
                      <h3 class="min-w-0 break-words font-medium text-white/75">
                        {row().title}
                      </h3>
                      <span class="font-mono text-[9px] text-white/45">
                        {[row().codec, row().resolution]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <StatisticsMetrics
                      metrics={row().summary}
                    />
                    <Show when={row().implementation}>
                      <p class="font-mono text-[9px] text-white/40 [overflow-wrap:anywhere]">
                        {row().implementation}
                      </p>
                    </Show>
                    <StatisticsMetrics
                      metrics={row().details}
                    />
                  </section>
                )}
              </Index>
            </Show>
          </Show>
        </div>
      </section>
    </div>
  );
}
