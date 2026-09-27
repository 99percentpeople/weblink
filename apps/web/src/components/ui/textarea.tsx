import { cn } from "@/libs/cn";
import {
  Component,
  ComponentProps,
  splitProps,
} from "solid-js";

export interface TextareaProps
  extends ComponentProps<"textarea"> {}

const Textarea: Component<TextareaProps> = (props) => {
  const [local, other] = splitProps(props, ["class"]);
  return (
    <textarea
      class={cn(
        `flex min-h-9 w-full rounded-md border border-input
        bg-transparent px-3 py-2 text-sm shadow-sm
        placeholder:text-muted-foreground focus-visible:outline-none
        focus-visible:ring-1 focus-visible:ring-ring
        disabled:cursor-not-allowed disabled:opacity-50`,
        local.class,
      )}
      {...other}
    />
  );
};

export { Textarea };
