import {
  createMemo,
  createSignal,
  onMount,
  type JSX,
  type ParentProps,
} from "solid-js";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { cn } from "@/libs/cn";

/** Shared list/detail lifetime and transitions for the meeting sidebar. */
export function SidebarBrowser(
  props: ParentProps<{
    split: boolean;
    browsing: boolean;
    list: JSX.Element;
    onDetailExitComplete?: () => void;
  }>,
) {
  const [navigationReady, setNavigationReady] =
    createSignal(false);
  onMount(() =>
    queueMicrotask(() => setNavigationReady(true)),
  );

  const listOnly = () => props.browsing && !props.split;
  const showList = () => props.split || props.browsing;
  // Presence keeps the list mounted after split mode ends. Retain the last
  // visible width mode so its exit layer cannot expand across the detail pane.
  const listSplit = createMemo<boolean>(
    (previous) => (showList() ? props.split : previous),
    props.split,
  );
  const showDetail = () => props.split || !props.browsing;
  const listExitingToDetail = () =>
    !props.browsing && !props.split;
  const detailExitingToList = () =>
    props.browsing && !props.split;

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          class={cn(
            `flex min-h-0 flex-none transition-[width] duration-[280ms]
            ease-[cubic-bezier(0.22,1,0.36,1)]
            motion-reduce:transition-none`,
            listExitingToDetail()
              ? "overflow-visible"
              : "overflow-hidden",
            props.split
              ? "w-60"
              : listOnly()
                ? "w-full"
                : "w-0",
          )}
        >
          <AnimatePresence when={showList()}>
            <Motion.div
              class={cn(
                "flex min-h-0 min-w-0 overflow-hidden",
                listSplit() && "border-r",
                listExitingToDetail() && listSplit()
                  ? "w-60"
                  : "w-full",
                listExitingToDetail() &&
                  "absolute inset-y-0 left-0 z-10",
              )}
              initial={
                navigationReady()
                  ? { opacity: 0, x: -12 }
                  : false
              }
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{
                duration: 0.2,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {props.list}
            </Motion.div>
          </AnimatePresence>
        </div>

        <AnimatePresence
          when={showDetail()}
          onExitComplete={props.onDetailExitComplete}
        >
          <Motion.div
            class={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              detailExitingToList() &&
                "absolute inset-0 z-10 w-full",
            )}
            initial={
              navigationReady()
                ? { opacity: 0, x: 12 }
                : false
            }
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{
              duration: 0.2,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            {props.children}
          </Motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
