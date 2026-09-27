import { cn } from "@/libs/cn";
import type { CheckboxControlProps } from "@kobalte/core/checkbox";
import { Checkbox as CheckboxPrimitive } from "@kobalte/core/checkbox";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { ValidComponent, VoidProps } from "solid-js";
import { splitProps } from "solid-js";

export const CheckboxLabel = CheckboxPrimitive.Label;
export const Checkbox = CheckboxPrimitive;
export const CheckboxErrorMessage =
  CheckboxPrimitive.ErrorMessage;
export const CheckboxDescription =
  CheckboxPrimitive.Description;

type checkboxControlProps<
  T extends ValidComponent = "div",
> = VoidProps<CheckboxControlProps<T> & { class?: string }>;

export const CheckboxControl = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<T, checkboxControlProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as checkboxControlProps,
    ["class", "children"],
  );

  return (
    <>
      <CheckboxPrimitive.Input
        class="[&:focus-visible+div]:ring-ring
          [&:focus-visible+div]:ring-offset-background
          [&:focus-visible+div]:ring-[1.5px]
          [&:focus-visible+div]:ring-offset-2
          [&:focus-visible+div]:outline-none"
      />
      <CheckboxPrimitive.Control
        class={cn(
          `peer border-input dark:bg-input/30 data-[checked]:bg-primary
          data-[checked]:text-primary-foreground
          dark:data-[checked]:bg-primary data-[checked]:border-primary
          focus-visible:border-ring focus-visible:ring-ring/50
          aria-invalid:ring-destructive/20
          dark:aria-invalid:ring-destructive/40
          aria-invalid:border-destructive size-4 shrink-0
          rounded-[4px] border shadow-xs transition-shadow
          outline-none focus-visible:ring-[3px]
          disabled:cursor-not-allowed disabled:opacity-50`,
          local.class,
        )}
        {...rest}
      >
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          class="flex items-center justify-center text-current
            transition-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
          >
            <path
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="m5 12l4 4 8-8"
            />
            <title>Checkbox</title>
          </svg>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Control>
    </>
  );
};
