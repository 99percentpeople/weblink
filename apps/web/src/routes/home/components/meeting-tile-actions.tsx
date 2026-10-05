import type { TileActionProps } from "./meeting-tile-actions-scope";
import { useViewScopes } from "@/libs/state/view-scopes";
import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  useContext,
  type ParentProps,
} from "solid-js";
import { Ellipsis } from "lucide-solid";
import { Motion } from "@/components/ui/motion";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Action owners and the invisible keyboard editor survive menu open/close. */
export function MeetingTileActions(
  props: ParentProps<{
    compact: boolean;
    label: string;
    portalMount?: HTMLElement;
  }>,
) {
  const ActionsContext = useViewScopes().tileActions;
  const [touch, setTouch] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  const [keyboardFocus, setKeyboardFocus] =
    createSignal(false);
  const [actions, setActions] = createSignal<
    TileActionProps[]
  >([]);
  let keepFocus = false;
  let trigger: HTMLButtonElement | undefined;
  const select = (action: TileActionProps) => {
    if (action.disabled) return;
    keepFocus = action.keepFocus === true;
    setOpen(false);
    action.onAction();
  };
  const compact = () => props.compact || touch();
  const expanded = () =>
    !compact() && (hovered() || keyboardFocus());
  onMount(() => {
    const media = window.matchMedia(
      "(hover: none), (pointer: coarse)",
    );
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener("change", update);
    onCleanup(() =>
      media.removeEventListener("change", update),
    );
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
      <div
        class="meeting-tile-actions"
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch")
            setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onFocusIn={(event) =>
          setKeyboardFocus(
            event.target.matches(
              ".meeting-icon-button:focus-visible",
            ),
          )
        }
        onFocusOut={(event) => {
          if (
            !event.currentTarget.contains(
              event.relatedTarget as Node | null,
            )
          )
            setKeyboardFocus(false);
        }}
      >
        <Show when={!compact()}>
          <button
            type="button"
            class="meeting-icon-button meeting-tile-actions-trigger"
            aria-label={props.label}
            aria-expanded={expanded()}
            title={props.label}
            onPointerDown={(event) =>
              event.stopPropagation()
            }
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(
                  ".meeting-tile-action:not(:disabled)",
                )
                ?.focus({ preventScroll: true });
            }}
          >
            <Ellipsis />
          </button>
          <div class="meeting-tile-actions-row">
            <For each={actions()}>
              {(action, index) => (
                <Motion.div
                  native
                  class="meeting-tile-action-slot"
                  initial={false}
                  animate={{
                    width: expanded()
                      ? "calc(var(--meeting-tile-action-size) + var(--meeting-tile-action-gap))"
                      : "0px",
                    opacity: expanded() ? 1 : 0,
                  }}
                  transition={{
                    duration: 0.22,
                    ease: [0.22, 1, 0.36, 1],
                    // Unfold from the trigger, then fold back toward it.
                    delay:
                      Math.min(
                        expanded()
                          ? actions().length - 1 - index()
                          : index(),
                        5,
                      ) * 0.025,
                  }}
                  inert={!expanded()}
                >
                  <TileActionButton {...action} />
                </Motion.div>
              )}
            </For>
          </div>
        </Show>
        {/* Keep action owners and the keyboard editor outside the clipped, inert reveal. */}
        {props.children}
        <Show when={compact()}>
          <DropdownMenu
            modal={false}
            placement="top-end"
            // Fullscreen escapes the tile's clipping ancestors, but Floating UI
            // still sees them. Keep its menu above the bottom-right trigger.
            flip={!props.portalMount}
            slide={!props.portalMount}
            open={open()}
            onOpenChange={(next) => {
              if (next) keepFocus = false;
              setOpen(next);
            }}
          >
            <DropdownMenuTrigger
              ref={trigger}
              class="meeting-icon-button"
              aria-label={props.label}
              title={props.label}
              onPointerDown={(event) =>
                event.stopPropagation()
              }
              onClick={(event) => event.stopPropagation()}
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              portalMount={props.portalMount}
              // The dropdown wrapper otherwise restores trigger focus even
              // when onCloseAutoFocus is prevented, dismissing the mobile IME.
              manualFocus
              class="min-w-44 max-w-[calc(100vw-1rem)] overflow-y-auto"
              style={{
                // The computed popper height includes the same stale ancestors.
                "max-height": props.portalMount
                  ? "calc(100dvh - 4rem)"
                  : "var(--kb-popper-content-available-height)",
              }}
              onInteractOutside={() => {
                keepFocus = true;
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (
                  !keepFocus &&
                  !open() &&
                  trigger?.isConnected
                )
                  trigger.focus({ preventScroll: true });
              }}
            >
              <For
                each={[...actions()].sort(
                  (a, b) => (a.order ?? 2) - (b.order ?? 2),
                )}
              >
                {(action) => (
                  <DropdownMenuItem
                    disabled={action.disabled}
                    closeOnSelect={false}
                    // Wait for click after touch-generated mouse focus. The
                    // keyboard must open synchronously in that completed gesture.
                    onClick={(event) => {
                      event.preventDefault();
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
                  </DropdownMenuItem>
                )}
              </For>
            </DropdownMenuContent>
          </DropdownMenu>
        </Show>
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
