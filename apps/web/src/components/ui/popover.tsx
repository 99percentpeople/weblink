import { cn } from "@/libs/cn";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type {
  PopoverContentProps,
  PopoverRootProps,
} from "@kobalte/core/popover";
import { Popover as PopoverPrimitive } from "@kobalte/core/popover";
import type {
  ComponentProps,
  ParentProps,
  ValidComponent,
} from "solid-js";
import { mergeProps, splitProps } from "solid-js";

export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverTitle = PopoverPrimitive.Title;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverDescription =
  PopoverPrimitive.Description;

export const Popover = (props: PopoverRootProps) => {
  const merge = mergeProps<PopoverRootProps[]>(
    {
      gutter: 4,
      flip: false,
    },
    props,
  );

  return <PopoverPrimitive {...merge} />;
};

type popoverContentProps<T extends ValidComponent = "div"> =
  ParentProps<
    PopoverContentProps<T> & {
      class?: string;
    }
  >;

export const PopoverContent = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<T, popoverContentProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as popoverContentProps,
    ["class", "children"],
  );

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        class={cn(
          `bg-popover text-popover-foreground
          data-[expanded]:animate-in data-[closed]:animate-out
          data-[closed]:fade-out-0 data-[expanded]:fade-in-0
          data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 z-50
          w-72 rounded-lg border p-4 shadow-md outline-none`,
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
};

type popoverCloseButtonProps<
  T extends ValidComponent = "button",
> = ComponentProps<T>;

export const PopoverCloseButton = <
  T extends ValidComponent = "button",
>(
  props: PolymorphicProps<T, popoverCloseButtonProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as popoverCloseButtonProps,
    ["class"],
  );
  return (
    <PopoverPrimitive.CloseButton
      class={cn(
        `ring-offset-background focus:ring-ring absolute top-4
        right-4 rounded-sm opacity-70
        transition-[opacity,box-shadow] hover:opacity-100
        focus:ring-[1.5px] focus:ring-offset-2 focus:outline-none
        disabled:pointer-events-none`,
        local.class,
      )}
      {...rest}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        class="h-4 w-4"
      >
        <path
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M18 6L6 18M6 6l12 12"
        />
        <title>Close</title>
      </svg>
    </PopoverPrimitive.CloseButton>
  );
};
