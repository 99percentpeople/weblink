import { cn } from "@/libs/cn";
import {
  Component,
  ComponentProps,
  splitProps,
} from "solid-js";
import { Input, InputProps } from "./input";

export const InputGroup: Component<
  ComponentProps<"div">
> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);

  return (
    <div
      class={cn(
        `border-input focus-within:ring-ring flex h-9 w-full
        items-stretch overflow-hidden rounded-md border
        bg-transparent shadow-sm transition-[color,box-shadow]
        focus-within:ring-1`,
        local.class,
      )}
      {...rest}
    />
  );
};

export const InputGroupInput: Component<InputProps> = (
  props,
) => {
  const [local, rest] = splitProps(props, ["class"]);

  return (
    <Input
      class={cn(
        `h-full min-w-0 flex-1 rounded-none border-0 shadow-none
        focus-visible:ring-0`,
        local.class,
      )}
      {...rest}
    />
  );
};

export const InputGroupButton: Component<
  ComponentProps<"button">
> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);

  return (
    <button
      class={cn(
        `border-input hover:bg-accent hover:text-accent-foreground
        focus-visible:ring-ring inline-flex h-full shrink-0
        items-center justify-center gap-2 border-0 border-l px-3
        text-sm font-medium transition-colors focus-visible:ring-1
        focus-visible:outline-none focus-visible:ring-inset
        disabled:pointer-events-none disabled:opacity-50`,
        local.class,
      )}
      {...rest}
    />
  );
};
