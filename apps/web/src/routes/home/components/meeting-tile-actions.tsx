import type { TileActionProps } from "./meeting-tile-actions-scope";
import { useViewScopes } from "@/libs/state/view-scopes";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  on,
  onMount,
  Show,
  useContext,
  type ParentProps,
} from "solid-js";
import { ChevronRight, Ellipsis } from "lucide-solid";
import { Portal } from "solid-js/web";
import { t } from "@/i18n";
import { createFloatingTileActions } from "./create-floating-tile-actions";
import { layoutActionFan } from "./meeting-action-fan";
import { createPortaledActionMenu } from "./create-portaled-action-menu";
import { MeetingActionGlass } from "./meeting-action-glass";

/** Action owners and the invisible keyboard editor survive menu open/close. */
export function MeetingTileActions(
  props: ParentProps<{
    compact: boolean;
    floating?: boolean;
    label: string;
    portalMount?: HTMLElement;
  }>,
) {
  const ActionsContext = useViewScopes().tileActions;
  const menuId = createUniqueId();
  const [touch, setTouch] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  const [clicked, setClicked] = createSignal(false);
  const [keyboardFocus, setKeyboardFocus] =
    createSignal(false);
  const [actions, setActions] = createSignal<
    TileActionProps[]
  >([]);
  const [page, setPage] = createSignal(0);
  let container!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  const [panelMount, setPanelMount] =
    createSignal<HTMLDivElement>();
  const mount = () =>
    props.portalMount ?? panelMount()?.ownerDocument.body;
  let hoverBlocked = false;
  let hoverTimer: number | undefined;
  const assistive = () => props.floating !== false;
  const compact = () => props.compact || touch();
  const cancelHoverDismiss = () => {
    container?.ownerDocument.defaultView?.clearTimeout(
      hoverTimer,
    );
    hoverTimer = undefined;
  };
  const dismiss = () => {
    cancelHoverDismiss();
    setClicked(false);
    setHovered(false);
    setKeyboardFocus(false);
  };
  const floating = createFloatingTileActions({
    enabled: assistive,
    container: () => container,
    trigger: () => trigger,
    onActivate() {
      hoverBlocked = false;
      if (clicked()) dismiss();
      else setClicked(true);
    },
    onDragStart() {
      hoverBlocked = true;
      dismiss();
    },
  });
  createEffect(on(assistive, dismiss, { defer: true }));
  const expanded = () =>
    !floating.dragging() &&
    (clicked() ||
      (!compact() && (hovered() || keyboardFocus())));
  const portaled = createPortaledActionMenu({
    radial: () => assistive() && !!fan(),
    open: expanded,
    anchor: () => trigger,
    panel: () => panel,
    mount,
  });
  const contains = (target: Node | null) =>
    !!target &&
    (container.contains(target) || panel.contains(target));
  const pointerEnter = (event: PointerEvent) => {
    if (
      event.pointerType !== "mouse" ||
      hoverBlocked ||
      floating.dragging()
    )
      return;
    cancelHoverDismiss();
    setHovered(true);
  };
  const pointerLeave = (event: PointerEvent) => {
    if (contains(event.relatedTarget as Node | null))
      return;
    cancelHoverDismiss();
    hoverTimer =
      container.ownerDocument.defaultView!.setTimeout(
        () => setHovered(false),
        150,
      );
    if (!floating.dragging()) hoverBlocked = false;
  };
  const focusOut = (event: FocusEvent) => {
    if (contains(event.relatedTarget as Node | null))
      return;
    setClicked(false);
    setKeyboardFocus(false);
  };
  const ordered = createMemo(() =>
    compact()
      ? [...actions()].sort(
          (a, b) => (a.order ?? 2) - (b.order ?? 2),
        )
      : actions(),
  );
  const availableFan = createMemo(() => {
    if (!assistive()) return;
    const layout = layoutActionFan(
      ordered().length,
      portaled.space(),
    );
    // Very small windows retain a scrollable menu instead of shrinking targets.
    return layout &&
      layout.points.length >= Math.min(2, ordered().length)
      ? layout
      : undefined;
  });
  const pageSize = () =>
    availableFan() &&
    availableFan()!.points.length < ordered().length
      ? Math.max(1, availableFan()!.points.length - 1)
      : ordered().length || 1;
  const pages = () =>
    Math.ceil(ordered().length / pageSize());
  const visibleActions = createMemo(() =>
    ordered().slice(
      page() * pageSize(),
      (page() + 1) * pageSize(),
    ),
  );
  const fan = createMemo(() => {
    const available = availableFan();
    if (!available) return;
    // The final page has its own row counts, including the next-page button.
    const count =
      visibleActions().length + (pages() > 1 ? 1 : 0);
    return count === available.points.length
      ? available
      : layoutActionFan(count, portaled.space());
  });
  createEffect(() => {
    if (!expanded() || page() >= pages()) setPage(0);
  });
  const buttons = () =>
    Array.from(
      panel.querySelectorAll<HTMLButtonElement>(
        "button[data-meeting-action]:not(:disabled)",
      ),
    );
  const focusAction = (last = false) => {
    const items = buttons();
    (last ? items.at(-1) : items[0])?.focus({
      preventScroll: true,
    });
  };
  const openWithKeyboard = (last = false) => {
    setClicked(true);
    queueMicrotask(() => {
      if (expanded()) focusAction(last);
    });
  };
  const select = (action: TileActionProps) => {
    if (action.disabled) return;
    if (compact()) {
      dismiss();
      if (!action.keepFocus)
        trigger.focus({ preventScroll: true });
    }
    // Keep text input in the completed click/keydown gesture on mobile Safari.
    action.onAction();
  };
  onMount(() => {
    const doc = container.ownerDocument;
    const win = doc.defaultView!;
    const media = win.matchMedia(
      "(hover: none), (pointer: coarse)",
    );
    const update = () => {
      dismiss();
      setTouch(media.matches);
    };
    update();
    const abort = new AbortController();
    media.addEventListener("change", update, {
      signal: abort.signal,
    });
    doc.addEventListener(
      "pointerdown",
      (event) => {
        if (
          expanded() &&
          !event.composedPath().includes(container) &&
          !event.composedPath().includes(panel)
        )
          dismiss();
      },
      { capture: true, signal: abort.signal },
    );
    win.addEventListener("blur", dismiss, {
      signal: abort.signal,
    });
    onCleanup(() => {
      cancelHoverDismiss();
      abort.abort();
    });
  });
  const itemStyle = (index: number) => ({
    "--fan-x": `${fan()?.points[index]?.x ?? 0}px`,
    "--fan-y": `${fan()?.points[index]?.y ?? 0}px`,
  });
  return (
    <ActionsContext.Provider
      value={{
        register(action) {
          setActions((current) => [...current, action]);
          return () =>
            setActions((current) =>
              current.filter((item) => item !== action),
            );
        },
      }}
    >
      <div class="meeting-tile-actions-boundary">
        <div
          ref={container}
          class="meeting-tile-actions"
          classList={{ "is-static": !assistive() }}
          data-edge={floating.edge()}
          data-side={
            floating.opensRight() ? "left" : "right"
          }
          data-below={floating.below() ? "" : undefined}
          data-dragging={
            floating.dragging() ? "" : undefined
          }
          data-expanded={expanded() ? "" : undefined}
          onPointerEnter={pointerEnter}
          onPointerLeave={pointerLeave}
          onFocusIn={(event) =>
            setKeyboardFocus(
              event.target.matches(
                ".meeting-icon-button:focus-visible",
              ),
            )
          }
          onFocusOut={focusOut}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !expanded())
              return;
            event.preventDefault();
            event.stopPropagation();
            trigger.focus({ preventScroll: true });
            dismiss();
          }}
        >
          <button
            ref={trigger}
            type="button"
            class="meeting-icon-button meeting-tile-actions-trigger"
            aria-label={props.label}
            aria-controls={menuId}
            aria-haspopup={compact() ? "menu" : undefined}
            aria-expanded={expanded()}
            aria-pressed={compact() ? undefined : clicked()}
            title={props.label}
            onKeyDown={(event) => {
              if (
                event.key !== "ArrowDown" &&
                event.key !== "ArrowUp"
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              openWithKeyboard(event.key === "ArrowUp");
            }}
          >
            <Show
              when={assistive()}
              fallback={<Ellipsis aria-hidden="true" />}
            >
              <span
                class="meeting-assistive-dot"
                aria-hidden="true"
              />
            </Show>
          </button>
          <div ref={setPanelMount} class="contents" />
          <Portal mount={mount()}>
            <div
              ref={panel}
              id={menuId}
              role={compact() ? "menu" : "toolbar"}
              aria-label={props.label}
              aria-hidden={
                compact() ? !expanded() : undefined
              }
              inert={!expanded()}
              class="meeting-action-panel"
              classList={{
                "is-fan": !!fan(),
                "is-list": !fan(),
                "is-portal": true,
              }}
              data-layout={fan()?.shape ?? "list"}
              data-expanded={expanded() ? "" : undefined}
              onPointerEnter={pointerEnter}
              onPointerLeave={pointerLeave}
              onFocusOut={focusOut}
              style={{
                "--menu-width": `${floating.menuSize()?.width ?? 280}px`,
                "--menu-height": `${floating.menuSize()?.height ?? 320}px`,
              }}
              onKeyDown={(event) => {
                const items = buttons();
                const index = items.indexOf(
                  event.target as HTMLButtonElement,
                );
                let next: number;
                switch (event.key) {
                  case "Escape":
                    event.preventDefault();
                    event.stopPropagation();
                    trigger.focus({ preventScroll: true });
                    dismiss();
                    return;
                  case "ArrowDown":
                  case "ArrowRight":
                    next = (index + 1) % items.length;
                    break;
                  case "ArrowUp":
                  case "ArrowLeft":
                    next =
                      (index - 1 + items.length) %
                      items.length;
                    break;
                  case "Home":
                    next = 0;
                    break;
                  case "End":
                    next = items.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                items[next]?.focus({ preventScroll: true });
              }}
            >
              <Show when={fan()}>
                {(layout) => (
                  <div
                    class="meeting-action-fan-surface"
                    aria-hidden="true"
                    style={{
                      width: `${layout().radius * 2}px`,
                      height: `${layout().radius * 2}px`,
                      left: `calc(50% - ${layout().radius}px)`,
                      top: `calc(50% - ${layout().radius}px)`,
                    }}
                  >
                    <MeetingActionGlass shape={layout()} />
                    {/* Keep hit testing separate: ancestor clipping blocks backdrop blur. */}
                    <svg
                      class="meeting-action-fan-hit"
                      width={layout().radius * 2}
                      height={layout().radius * 2}
                      viewBox={`${-layout().radius} ${-layout().radius} ${layout().radius * 2} ${layout().radius * 2}`}
                    >
                      <path d={layout().path} />
                    </svg>
                  </div>
                )}
              </Show>
              <For each={visibleActions()}>
                {(action, index) => (
                  <button
                    type="button"
                    data-meeting-action=""
                    class="meeting-icon-button meeting-tile-action"
                    role={
                      compact() ? "menuitem" : undefined
                    }
                    aria-label={action.label}
                    aria-pressed={action.active}
                    disabled={action.disabled}
                    title={action.title ?? action.label}
                    style={itemStyle(index())}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (action.keepFocus && action.active)
                        event.preventDefault();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(action);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.repeat ||
                        (event.key !== "Enter" &&
                          event.key !== " ")
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      select(action);
                    }}
                  >
                    {action.children}
                    <span>{action.label}</span>
                  </button>
                )}
              </For>
              <Show when={pages() > 1}>
                <button
                  type="button"
                  data-meeting-action=""
                  class="meeting-icon-button meeting-tile-action"
                  role={compact() ? "menuitem" : undefined}
                  aria-label={t("common.pagination.next")}
                  title={t("common.pagination.page", {
                    page: page() + 1,
                    count: pages(),
                  })}
                  style={itemStyle(visibleActions().length)}
                  onPointerDown={(event) =>
                    event.stopPropagation()
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    setPage(
                      (current) => (current + 1) % pages(),
                    );
                    focusAction();
                  }}
                >
                  <ChevronRight />
                  <span>
                    {page() + 1} / {pages()}
                  </span>
                </button>
              </Show>
            </div>
          </Portal>
          {/* Keep action owners and the keyboard editor outside the inert menu. */}
          {props.children}
        </div>
      </div>
    </ActionsContext.Provider>
  );
}

export function MeetingTileAction(props: TileActionProps) {
  const context = useContext(useViewScopes().tileActions);
  onMount(() => {
    if (context) onCleanup(context.register(props));
  });
  return context ? null : <TileActionButton {...props} />;
}

function TileActionButton(props: TileActionProps) {
  return (
    <button
      type="button"
      class="meeting-icon-button meeting-tile-action"
      aria-label={props.label}
      title={props.title ?? props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (props.keepFocus && props.active)
          event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        props.onAction();
      }}
    >
      {props.children}
    </button>
  );
}
