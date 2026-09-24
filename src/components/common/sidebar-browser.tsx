import { Show, type JSX, type ParentProps } from "solid-js";
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
  }>,
) {
  const listOnly = () => props.browsing && !props.split;
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          class={cn(
            `flex min-h-0 flex-none overflow-hidden transition-[width]
            duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]
            motion-reduce:transition-none`,
            props.split
              ? "w-60"
              : listOnly()
                ? "w-full"
                : "w-0",
          )}
        >
          <AnimatePresence when={props.split || listOnly()}>
            <Motion.div
              class={cn(
                "flex min-h-0 w-full min-w-0 overflow-hidden",
                !listOnly() && "border-r",
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              {props.list}
            </Motion.div>
          </AnimatePresence>
        </div>
        <Show when={!listOnly()}>
          <Motion.div
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
          >
            {props.children}
          </Motion.div>
        </Show>
      </div>
    </div>
  );
}
