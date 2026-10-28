import { splitProps, type ComponentProps } from "solid-js";
import { cn } from "@/libs/cn";

type ProgressCircleProps = ComponentProps<"svg"> & {
  value?: number;
  indeterminate?: boolean;
};

export function ProgressCircle(props: ProgressCircleProps) {
  const [local, rest] = splitProps(props, [
    "value",
    "indeterminate",
    "class",
  ]);
  const percent = () =>
    Math.min(100, Math.max(0, local.value ?? 0));

  return (
    <svg
      class={cn(
        "pointer-events-none size-11 shrink-0 -rotate-90",
        local.indeterminate && "animate-spin",
        local.class,
      )}
      viewBox="0 0 44 44"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={
        local.indeterminate ? undefined : percent()
      }
      {...rest}
    >
      <circle
        cx="22"
        cy="22"
        r="19"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        class="opacity-15"
      />
      <circle
        cx="22"
        cy="22"
        r="19"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        pathLength="100"
        stroke-dasharray="100"
        stroke-dashoffset={
          100 - (local.indeterminate ? 25 : percent())
        }
        class="transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}
