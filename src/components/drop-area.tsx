import { cn } from "@/libs/cn";
import {
  createSignal,
  onCleanup,
  onMount,
  splitProps,
  type JSX,
  type ParentProps,
  type ValidComponent,
} from "solid-js";
import { Dynamic } from "solid-js/web";

export interface DropAreaState {
  readonly active: boolean;
  readonly accepted: boolean;
}

interface DropAreaProps<
  T extends ValidComponent,
> extends ParentProps {
  overlay?: (state: DropAreaState) => JSX.Element;
  onDrop?: (event: DragEvent) => void;
  disabled?: boolean;
  ref?: (element: HTMLElement) => void;
  as?: T;
  class?: string;
}

export default function DropArea<T extends ValidComponent>(
  props: DropAreaProps<T>,
) {
  const [local, other] = splitProps(props, [
    "class",
    "children",
    "overlay",
    "onDrop",
    "disabled",
    "ref",
    "as",
  ]);
  let element: HTMLElement | undefined;
  const entered = new Set<EventTarget>();
  const [active, setActive] = createSignal(false);
  // Keep the overlay owner mounted across state changes so it can finish an
  // exit animation. Consumers read reactive getters, not a replaced snapshot.
  const state: DropAreaState = {
    get active() {
      return active();
    },
    get accepted() {
      return active() && !local.disabled;
    },
  };
  const reset = () => {
    entered.clear();
    setActive(false);
  };
  const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes(
      "Files",
    );
  const contains = (target: EventTarget | null) =>
    target instanceof Node && !!element?.contains(target);
  const accept = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = local.disabled
        ? "none"
        : "copy";
  };
  const handleDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    accept(event);
    if (event.target) entered.add(event.target);
    setActive(true);
  };
  const handleDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    accept(event);
    // Do not publish each DragEvent: that remounts overlays on every dragover.
    setActive(true);
  };
  const handleDragLeave = (event: DragEvent) => {
    if (!active()) return;
    event.stopPropagation();
    if (event.target) entered.delete(event.target);
    // Child transitions bubble too. relatedTarget may be null for OS files,
    // so keep entered targets until the final matching leave in that case.
    if (contains(event.relatedTarget)) return;
    if (event.relatedTarget || entered.size === 0) reset();
  };
  const handleDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    accept(event);
    reset();
    if (!local.disabled) local.onDrop?.(event);
  };

  onMount(() => {
    const controller = new AbortController();
    const options = {
      capture: true,
      signal: controller.signal,
    };
    window.addEventListener("drop", reset, options);
    window.addEventListener("dragend", reset, options);
    window.addEventListener("blur", reset, options);
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") reset();
      },
      options,
    );
    window.addEventListener(
      "dragleave",
      (event) => {
        if (
          !event.relatedTarget &&
          (event.target === document ||
            event.target === document.documentElement)
        )
          reset();
      },
      options,
    );
    window.addEventListener(
      "dragover",
      (event) => {
        if (!contains(event.target)) reset();
      },
      options,
    );
    onCleanup(() => controller.abort());
  });

  return (
    <Dynamic
      component={local.as ?? "div"}
      ref={(value: HTMLElement) => {
        element = value;
        local.ref?.(value);
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      class={cn(local.class)}
      {...other}
    >
      {local.children}
      {local.overlay?.(state)}
    </Dynamic>
  );
}
