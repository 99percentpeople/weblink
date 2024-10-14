import { cn } from "@/libs/cn";
import {
  Component,
  ComponentProps,
  splitProps,
} from "solid-js";

export interface InputProps
  extends ComponentProps<"input"> {}

export const Input: Component<InputProps> = (
  props: InputProps,
) => {
  const [local, rest] = splitProps(props, [
    "class",
    "type",
  ]);
  return (
    <input
      type={local.type}
      class={cn(
        inputClass,
        `px-3 py-1 focus-visible:outline-none focus-visible:ring-1
        focus-visible:ring-ring`,
        local.class,
      )}
      {...rest}
    />
  );
};

export const inputClass = `flex h-9 w-full rounded-md border border-input
        bg-transparent text-sm shadow-sm transition-colors
        file:border-0 file:bg-transparent file:text-sm
        file:font-medium placeholder:text-muted-foreground
        disabled:cursor-not-allowed
        disabled:opacity-50`;
