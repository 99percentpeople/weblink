import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
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
  const [exitLayer, setExitLayer] =
    createSignal<HTMLDivElement>();
  const tileElements = new Map<string, HTMLElement>();
  const [exitRects, setExitRects] = createSignal(
    new Map<string, DOMRect>(),
  );
  const railId = createUniqueId();
  const railCollapsed = () => props.railCollapsed;
  const [displayedPinnedId, setDisplayedPinnedId] =
    createSignal(props.pinnedId);
  const [sources, setSources] = createSignal(props.sources);
  const [renderedSources, setRenderedSources] =
    createSignal(props.sources);
  const layout = createMeetingGridLayout(
    grid,
    () => sources().length,
    (update) => props.transitionLayout(update),
  );
  const mergeRenderedSources = (
    next: readonly MeetingSource[],
  ) => {
    const nextById = new Map(
      next.map((source) => [source.id, source]),
    );
    const previous = untrack(renderedSources);
    const previousIds = new Set(
      previous.map((source) => source.id),
    );
    return [
      ...previous.map(
        (source) => nextById.get(source.id) ?? source,
      ),
      ...next.filter(
        (source) => !previousIds.has(source.id),
      ),
    ];
  };
  createEffect(
    on(
      () => [props.sources, props.pinnedId] as const,
      ([next, nextPinned]) => {
        const current = untrack(sources);
        const currentPinned = untrack(displayedPinnedId);
        const nextIds = new Set(
          next.map((source) => source.id),
        );
        const leavingRects = new Map<string, DOMRect>();
        for (const source of current) {
          if (nextIds.has(source.id)) continue;
          const element = tileElements.get(source.id);
          if (element)
            leavingRects.set(
              source.id,
              element.getBoundingClientRect(),
            );
        }
        const sameIds =
          current.length === next.length &&
          current.every(
            (source, i) => source.id === next[i].id,
          );
        if (sameIds && currentPinned === nextPinned) {
          // Stream/participant metadata does not need a layout animation.
          setSources(next);
          setRenderedSources(mergeRenderedSources(next));
          return;
        }

        // Source membership and featured ownership are one layout transaction.
        // This lets a replacement source move into the featured frame while the
        // removed source fades out, instead of leaving an empty intermediate frame.
        layout.schedule(() => {
          const latest = props.sources;
          // Apply exit positioning together with portal reparenting. Doing it
          // earlier makes fixed coordinates relative to the old grid container.
          // Returning sources must release their exit styles before measurement.
          setExitRects((current) => {
            const nextRects = new Map([
              ...current,
              ...leavingRects,
            ]);
            for (const source of latest)
              nextRects.delete(source.id);
            return nextRects;
          });
          setSources(latest);
          setRenderedSources(mergeRenderedSources(latest));
          setDisplayedPinnedId(props.pinnedId);
        });
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
        renderedSources().map((source) => [
          source.id,
          source,
        ]),
      ),
  );
  const activeIds = createMemo(
    () => new Set(sources().map((source) => source.id)),
  );
  const featured = createMemo(() =>
    selectMeetingFeaturedSource(
      sources(),
      displayedPinnedId(),
    ),
  );
  const rest = createMemo(() =>
    sources()
      .filter((source) => source.id !== featured()?.id)
      .map((source) => source.id),
  );
  const sourceIds = createMemo(() =>
    renderedSources().map((source) => source.id),
  );
  const removeRenderedSource = (id: string) => {
    if (untrack(activeIds).has(id)) return;
    setExitRects((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    tileElements.delete(id);
    setRenderedSources((current) =>
      current.filter((source) => source.id !== id),
    );
  };
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
        <AnimatePresence
          when={activeIds().has(tile.id)}
          onExitComplete={() =>
            removeRenderedSource(tile.id)
          }
        >
          <MeetingTile
            ref={(element) =>
              tileElements.set(source().id, element)
            }
            compact={props.compact}
            exiting={!activeIds().has(source().id)}
            exitRect={exitRects().get(source().id)}
            playbackActive={
              activeIds().has(source().id) &&
              props.active !== false &&
              layout().tileWidth > 0 &&
              (!featured() ||
                source().id === featured()?.id ||
                !railCollapsed())
            }
            onSelect={
              source().id !== featured()?.id &&
              (props.compact || Boolean(featured()))
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
              sources().length > 1 &&
              (!featured() ||
                source().id === featured()?.id)
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
        </AnimatePresence>
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
      <div
        ref={setExitLayer}
        class="pointer-events-none fixed inset-0 z-50"
        aria-hidden="true"
      />
      {/* Portal retains its content when the layout host changes. */}
      <For each={sourceIds()}>
        {(id, index) => (
          <Portal
            mount={
              !activeIds().has(id)
                ? exitLayer()
                : featured()
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
