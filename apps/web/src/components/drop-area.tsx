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
  let dragTarget: EventTarget | null = null;
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
    dragTarget = null;
    setActive(false);
  };
  const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes(
      "Files",
    );
  const contains = (target: EventTarget | null) =>
    target instanceof Node && !!element?.contains(target);
  const setDropEffect = (event: DragEvent) => {
    if (!hasFiles(event)) return false;
    event.preventDefault();
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = local.disabled
        ? "none"
        : "copy";
    return true;
  };
  const accept = (event: DragEvent) => {
    if (!setDropEffect(event)) return false;
    event.stopPropagation();
    return true;
  };
  const handleDragEnter = (event: DragEvent) => {
    if (!accept(event)) return;
    dragTarget = event.target;
    setActive(true);
  };
  const handleDragOver = (event: DragEvent) => {
    if (!accept(event)) return;
    // Do not publish each DragEvent: that remounts overlays on every dragover.
    dragTarget = event.target;
    setActive(true);
  };
  const handleDragLeave = (event: DragEvent) => {
    if (!active()) return;
    event.stopPropagation();
    if (contains(event.relatedTarget)) return;
    // A new target enters before the previous target leaves, so ignore the
    // old target's leave even when relatedTarget is missing. But a leave of
    // the current target ends the drag: rejected OS drops emit only this
    // event, not drop or a dragend in this document.
    if (event.relatedTarget || event.target === dragTarget)
      reset();
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
    // Set the native drag cursor before the event reaches changing child
    // targets. Waiting for the bubbling handler lets the browser briefly show
    // its default/no-drop cursor while crossing nested chat elements.
    element?.addEventListener(
      "dragenter",
      setDropEffect,
      options,
    );
    element?.addEventListener(
      "dragover",
      setDropEffect,
      options,
    );
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
