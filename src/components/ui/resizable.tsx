import { cn } from "@/libs/cn";
import type {
  DynamicProps,
  HandleProps,
  PanelProps,
  RootProps,
} from "@corvu/resizable";
import ResizablePrimitive from "@corvu/resizable";
import type { ValidComponent, VoidProps } from "solid-js";
import { Show, splitProps } from "solid-js";

type resizablePanelProps<T extends ValidComponent = "div"> =
  PanelProps<T> & {
    class?: string;
  };

export const ResizablePanel = <
  T extends ValidComponent = "div",
>(
  props: DynamicProps<T, resizablePanelProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as resizablePanelProps,
    ["class"],
  );

  return (
    <ResizablePrimitive.Panel
      class={cn("min-h-0 min-w-0", local.class)}
      {...rest}
    />
  );
};

type resizableProps<T extends ValidComponent = "div"> =
  RootProps<T> & {
    class?: string;
  };

export const Resizable = <T extends ValidComponent = "div">(
  props: DynamicProps<T, resizableProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as resizableProps,
    ["class"],
  );

  return (
    <ResizablePrimitive
      class={cn(
        `flex h-full min-h-0 w-full min-w-0
        data-[orientation=vertical]:flex-col`,
        local.class,
      )}
      {...rest}
    />
  );
};

type resizableHandleProps<
  T extends ValidComponent = "button",
> = VoidProps<
  HandleProps<T> & {
    class?: string;
    withHandle?: boolean;
  }
>;

export const ResizableHandle = <
  T extends ValidComponent = "button",
>(
  props: DynamicProps<T, resizableHandleProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as resizableHandleProps,
    ["class", "withHandle"],
  );

  return (
    <ResizablePrimitive.Handle
      class={cn(
        `focus-visible:ring-ring [&:not([data-active])]:bg-border
        [&[data-active]_#resizable-handle]:bg-muted-foreground/50
        [&[data-dragging]_#resizable-handle]:bg-muted-foreground/80
        relative flex w-px items-center justify-center
        overflow-visible transition-shadow
        focus-visible:ring-[1.5px] focus-visible:ring-offset-1
        focus-visible:outline-none data-[orientation=vertical]:h-px
        data-[orientation=vertical]:w-full
        [&[data-orientation=horizontal]_#resizable-handle]:h-full
        [&[data-orientation=horizontal][data-active]_#resizable-handle]:w-2
        [&[data-orientation=vertical]_#resizable-handle]:w-full
        [&[data-orientation=vertical][data-active]_#resizable-handle]:h-2`,
        local.class,
      )}
      {...rest}
    >
      <div
        id="resizable-handle"
        class="absolute z-50 transition-all"
      ></div>
      <Show when={local.withHandle}>
        <div
          class="bg-border fixed top-1/2 z-50 flex h-4 w-3 items-center
            justify-center rounded-sm border"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-2.5 w-2.5"
            viewBox="0 0 15 15"
          >
            <path
              fill="currentColor"
              fill-rule="evenodd"
              d="M5.5 4.625a1.125 1.125 0 1 0 0-2.25a1.125 1.125 0 0 0 0 2.25m4 0a1.125 1.125 0 1 0 0-2.25a1.125 1.125 0 0 0 0 2.25M10.625 7.5a1.125 1.125 0 1 1-2.25 0a1.125 1.125 0 0 1 2.25 0M5.5 8.625a1.125 1.125 0 1 0 0-2.25a1.125 1.125 0 0 0 0 2.25m5.125 2.875a1.125 1.125 0 1 1-2.25 0a1.125 1.125 0 0 1 2.25 0M5.5 12.625a1.125 1.125 0 1 0 0-2.25a1.125 1.125 0 0 0 0 2.25"
              clip-rule="evenodd"
            />
            <title>Resizable handle</title>
          </svg>
        </div>
      </Show>
    </ResizablePrimitive.Handle>
  );
};
