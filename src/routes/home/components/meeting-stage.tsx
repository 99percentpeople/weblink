import { Motion } from "@/components/ui/motion";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type ParentProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "@/i18n";
import { MeetingCollapseButton } from "./meeting-collapse-button";
import { MeetingTile } from "./meeting-tile";
import {
  selectMeetingFeaturedSource,
  type MeetingSource,
} from "./meeting-sources";
import { createMeetingGridLayout } from "./meeting-grid-layout";
import { useAudioPlayer } from "./audio-player";

export type MeetingStageHandle = { measure(): void };

export function MeetingStage(
  props: ParentProps<{
    ref?: (stage: MeetingStageHandle | undefined) => void;
    compact?: boolean;
    active?: boolean;
    sources: readonly MeetingSource[];
    pinnedId: string | null;
    hideRailToggle?: boolean;
    railCollapsed: boolean;
    onRailCollapsedChange(collapsed: boolean): void;
    onPin(id: string): void;
    onVideoPipEnter?(id: string): void;
    onStop(trackId: string): void;
    transitionLayout(update: () => void): void;
  }>,
) {
  const audio = useAudioPlayer();
  const [grid, setGrid] = createSignal<HTMLDivElement>();
  const [frame, setFrame] = createSignal<HTMLDivElement>();
  const [rail, setRail] = createSignal<HTMLDivElement>();
  const railId = createUniqueId();
  const railCollapsed = () => props.railCollapsed;
  const [sources, setSources] = createSignal(props.sources);
  const layout = createMeetingGridLayout(
    grid,
    () => sources().length,
    (update) => props.transitionLayout(update),
  );
  createEffect(
    on(
      () => props.sources,
      (next) => {
        const current = untrack(sources);
        if (
          current.length === next.length &&
          current.every(
            (source, i) => source.id === next[i].id,
          )
        ) {
          // Stream/participant metadata does not need a layout animation.
          setSources(next);
        } else {
          // Commit keyed views and grid geometry together, before measuring the
          // destination. Read the latest sources when rapid updates coalesce.
          layout.schedule(() => setSources(props.sources));
        }
      },
    ),
  );
  onMount(() => {
    props.ref?.({ measure: layout.measure });
    onCleanup(() => props.ref?.(undefined));
  });
  const byId = createMemo(
    () =>
      new Map(
        sources().map((source) => [source.id, source]),
      ),
  );
  const featured = createMemo(() =>
    selectMeetingFeaturedSource(sources(), props.pinnedId),
  );
  const rest = createMemo(() =>
    sources()
      .filter((source) => source.id !== featured()?.id)
      .map((source) => source.id),
  );
  const sourceIds = createMemo(() =>
    sources().map((source) => source.id),
  );
  const CollapseToggle = () => (
    <Motion.div
      class="meeting-thumbnails-toolbar"
      layout
      layoutId="meeting-thumbnail-controls"
    >
      <MeetingCollapseButton
        controls={railId}
        expanded={!railCollapsed()}
        onToggle={() =>
          props.transitionLayout(() =>
            props.onRailCollapsedChange(!railCollapsed()),
          )
        }
        label={t(
          railCollapsed()
            ? "meeting.show_sources"
            : "meeting.hide_sources",
        )}
      />
    </Motion.div>
  );
  const Tile = (tile: { id: string; order: number }) => (
    <Show when={byId().get(tile.id)}>
      {(source) => (
        <MeetingTile
          compact={props.compact}
          playbackActive={
            props.active !== false &&
            layout().tileWidth > 0 &&
            (!featured() ||
              source().id === featured()?.id ||
              !railCollapsed())
          }
          onSelect={
            props.compact && source().id !== featured()?.id
              ? () => props.onPin(source().id)
              : undefined
          }
          sourceId={source().id}
          order={tile.order}
          sourceKind={source().kind}
          trackId={source().track?.id}
          name={source().name}
          avatar={source().avatar}
          stream={source().stream}
          local={source().local}
          audioMuted={audio.isPeerMuted(
            source().participantId,
          )}
          onToggleAudio={() =>
            audio.setPeerMuted(
              source().participantId,
              !audio.isPeerMuted(source().participantId),
            )
          }
          pinned={source().id === featured()?.id}
          onPin={
            sources().length > 1
              ? () => props.onPin(source().id)
              : undefined
          }
          onVideoPipEnter={() =>
            props.onVideoPipEnter?.(source().id)
          }
          onStop={
            source().local && source().track
              ? () => props.onStop(source().track!.id)
              : undefined
          }
        />
      )}
    </Show>
  );

  return (
    <section
      class="meeting-stage"
      classList={{ "is-focused": Boolean(featured()) }}
      aria-label={t("meeting.stage")}
    >
      {props.children}
      <div
        ref={setGrid}
        class="meeting-grid"
        data-layout-ready={layout().tileWidth > 0}
        style={{
          "--meeting-grid-columns": layout().columns,
          "--meeting-grid-rows": layout().rows,
          "--meeting-tile-width": `${layout().tileWidth}px`,
          "--meeting-tile-height": `${layout().tileHeight}px`,
          "--meeting-grid-gap": `${layout().gap}px`,
          "--meeting-grid-offset-x": `${layout().offsetX}px`,
          "--meeting-grid-offset-y": `${layout().offsetY}px`,
        }}
        classList={{
          "has-featured": Boolean(featured()),
          "is-solo": sources().length === 1,
          "is-rail-collapsed": railCollapsed(),
          "is-rail-toggle-hidden": props.hideRailToggle,
        }}
      >
        {/* Keep branch cleanup separate from the views portaled into the grid. */}
        <div style={{ display: "contents" }}>
          <Show when={featured()}>
            <div
              ref={setFrame}
              class="meeting-featured-frame"
            />
            <Show when={rest().length}>
              <Show when={!props.hideRailToggle}>
                <CollapseToggle />
              </Show>
              <div
                ref={setRail}
                id={railId}
                class="meeting-thumbnails"
                classList={{
                  "is-collapsed": railCollapsed(),
                }}
                data-motion-layout-container="meeting-thumbnail-rail"
                inert={railCollapsed()}
                aria-hidden={railCollapsed()}
                aria-label={t("meeting.other_sources")}
              ></div>
            </Show>
          </Show>
        </div>
      </div>
      {/* Portal retains its content when the layout host changes. */}
      <For each={sourceIds()}>
        {(id, index) => (
          <Portal
            mount={
              featured()
                ? featured()?.id === id
                  ? frame()
                  : rail()
                : grid()
            }
            ref={(container) => {
              container.style.display = "contents";
            }}
          >
            <Tile id={id} order={index()} />
          </Portal>
        )}
      </For>
    </section>
  );
}
