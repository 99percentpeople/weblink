import { cn } from "@/libs/cn";
import { t } from "@/i18n";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { Component, ComponentProps } from "solid-js";
import { For, splitProps } from "solid-js";

const spinnerVariants = cva(
  "relative inline-block aspect-square transform-gpu",
  {
    variants: {
      variant: {
        default: "[&>div]:bg-foreground",
        primary: "[&>div]:bg-primary",
        secondary: "[&>div]:bg-secondary",
        destructive: "[&>div]:bg-destructive",
        muted: "[&>div]:bg-muted-foreground",
      },
      size: {
        sm: "size-4",
        default: "size-5",
        lg: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface SpinnerProps
  extends
    ComponentProps<"div">,
    Omit<VariantProps<typeof spinnerVariants>, "size"> {
  className?: string;
  size?:
    | VariantProps<typeof spinnerVariants>["size"]
    | number;
}

const leafNumber = 12;

const Spinner: Component<SpinnerProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "class",
    "size",
    "variant",
  ]);

  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      class={cn(
        typeof local.size === "string"
          ? spinnerVariants({
              variant: local.variant,
              size: local.size as VariantProps<
                typeof spinnerVariants
              >["size"],
            })
          : spinnerVariants({ variant: local.variant }),
        local.class,
      )}
      style={
        typeof local.size === "number"
          ? {
              width: `${local.size}px`,
              height: `${local.size}px`,
            }
          : undefined
      }
      {...rest}
    >
      <For each={Array.from({ length: leafNumber })}>
        {(_, i) => (
          <div
            class="animate-spinner absolute left-[46.5%] top-[4.4%] h-[24%]
              w-[7%] origin-[center_190%] rounded-full opacity-[0.1]
              will-change-transform"
            style={{
              transform: `rotate(${i() * (360 / leafNumber)}deg)`,
              "animation-delay": `${(i() * (1 / leafNumber)).toFixed(3)}s`,
            }}
            aria-hidden="true"
          />
        )}
      </For>
      <span class="sr-only">{t("common.loading")}</span>
    </div>
  );
};

export { Spinner };
