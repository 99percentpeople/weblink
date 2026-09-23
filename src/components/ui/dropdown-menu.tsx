import { cn } from "@/libs/cn";
import type {
  DropdownMenuCheckboxItemProps,
  DropdownMenuContentProps,
  DropdownMenuGroupLabelProps,
  DropdownMenuItemLabelProps,
  DropdownMenuItemProps,
  DropdownMenuRadioItemProps,
  DropdownMenuRootProps,
  DropdownMenuSeparatorProps,
  DropdownMenuSubTriggerProps,
} from "@kobalte/core/dropdown-menu";
import { DropdownMenu as DropdownMenuPrimitive } from "@kobalte/core/dropdown-menu";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type {
  ComponentProps,
  ParentProps,
  ValidComponent,
} from "solid-js";
import { mergeProps, splitProps } from "solid-js";

export const DropdownMenuTrigger =
  DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup =
  DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup =
  DropdownMenuPrimitive.RadioGroup;

export const DropdownMenu = (
  props: DropdownMenuRootProps,
) => {
  const merge = mergeProps<DropdownMenuRootProps[]>(
    { gutter: 4 },
    props,
  );

  return (
    <DropdownMenuPrimitive
      data-slot="dropdown-menu"
      {...merge}
    />
  );
};

type dropdownMenuContentProps<
  T extends ValidComponent = "div",
> = DropdownMenuContentProps<T> & {
  class?: string;
};

export const DropdownMenuContent = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<T, dropdownMenuContentProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuContentProps,
    ["class"],
  );

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        class={cn(
          `min-w-8rem bg-popover text-popover-foreground
          focus-visible:ring-ring data-[expanded]:animate-in
          data-[closed]:animate-out data-[closed]:fade-out-0
          data-[expanded]:fade-in-0 data-[closed]:zoom-out-95
          data-[expanded]:zoom-in-95 z-50 overflow-hidden rounded-lg
          border p-1 shadow-md transition-shadow
          focus-visible:ring-[1.5px] focus-visible:outline-none`,
          local.class,
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
};

type dropdownMenuItemProps<
  T extends ValidComponent = "div",
> = DropdownMenuItemProps<T> & {
  class?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
};

export const DropdownMenuItem = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<T, dropdownMenuItemProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuItemProps,
    ["class", "inset", "variant"],
  );

  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={local.inset}
      data-variant={local.variant}
      class={cn(
        `focus:bg-accent focus:text-accent-foreground
        data-[variant=destructive]:text-destructive
        data-[variant=destructive]:focus:bg-destructive/10
        dark:data-[variant=destructive]:focus:bg-destructive/20
        data-[variant=destructive]:focus:text-destructive
        data-[variant=destructive]:*:[svg]:!text-destructive
        [&_svg:not([class*='text-'])]:text-muted-foreground relative
        flex cursor-default items-center gap-2 rounded-sm px-2
        py-1.5 text-sm outline-hidden select-none
        data-[disabled]:pointer-events-none
        data-[disabled]:opacity-50 data-[inset]:pl-8
        [&_svg]:pointer-events-none [&_svg]:shrink-0
        [&_svg:not([class*='size-'])]:size-4`,
        local.class,
      )}
      {...rest}
    />
  );
};

type dropdownMenuGroupLabelProps<
  T extends ValidComponent = "span",
> = DropdownMenuGroupLabelProps<T> & {
  class?: string;
};

export const DropdownMenuGroupLabel = <
  T extends ValidComponent = "span",
>(
  props: PolymorphicProps<
    T,
    dropdownMenuGroupLabelProps<T>
  >,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuGroupLabelProps,
    ["class"],
  );

  return (
    <DropdownMenuPrimitive.GroupLabel
      as="div"
      data-slot="dropdown-menu-group-label"
      class={cn(
        "px-2 py-1.5 text-sm font-semibold",
        local.class,
      )}
      {...rest}
    />
  );
};

type dropdownMenuItemLabelProps<
  T extends ValidComponent = "div",
> = DropdownMenuItemLabelProps<T> & {
  class?: string;
  inset?: boolean;
};

export const DropdownMenuItemLabel = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<T, dropdownMenuItemLabelProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuItemLabelProps,
    ["class", "inset"],
  );

  return (
    <DropdownMenuPrimitive.ItemLabel
      as="div"
      data-slot="dropdown-menu-item-label"
      data-inset={local.inset}
      class={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        local.class,
      )}
      {...rest}
    />
  );
};

type dropdownMenuSeparatorProps<
  T extends ValidComponent = "hr",
> = DropdownMenuSeparatorProps<T> & {
  class?: string;
};

export const DropdownMenuSeparator = <
  T extends ValidComponent = "hr",
>(
  props: PolymorphicProps<T, dropdownMenuSeparatorProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuSeparatorProps,
    ["class"],
  );

  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      class={cn("bg-border -mx-1 my-1 h-px", local.class)}
      {...rest}
    />
  );
};

export const DropdownMenuShortcut = (
  props: ComponentProps<"span">,
) => {
  const [local, rest] = splitProps(props, ["class"]);

  return (
    <span
      class={cn(
        "ml-auto text-xs tracking-widest opacity-60",
        local.class,
      )}
      {...rest}
    />
  );
};

type dropdownMenuSubTriggerProps<
  T extends ValidComponent = "div",
> = ParentProps<
  DropdownMenuSubTriggerProps<T> & {
    class?: string;
    inset?: boolean;
  }
>;

export const DropdownMenuSubTrigger = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<
    T,
    dropdownMenuSubTriggerProps<T>
  >,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuSubTriggerProps,
    ["class", "children", "inset"],
  );

  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={local.inset}
      class={cn(
        `focus:bg-accent focus:text-accent-foreground
        data-[expanded]:bg-accent
        data-[expanded]:text-accent-foreground flex cursor-default
        items-center rounded-sm px-2 py-1.5 text-sm outline-hidden
        select-none data-[inset]:pl-8`,
        local.class,
      )}
      {...rest}
    >
      {local.children}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
        class="ml-auto h-4 w-4"
      >
        <path
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="m9 6l6 6l-6 6"
        />
        <title>Arrow</title>
      </svg>
    </DropdownMenuPrimitive.SubTrigger>
  );
};

type dropdownMenuSubContentProps<
  T extends ValidComponent = "div",
> = DropdownMenuSubTriggerProps<T> & {
  class?: string;
};

export const DropdownMenuSubContent = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<
    T,
    dropdownMenuSubContentProps<T>
  >,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuSubContentProps,
    ["class"],
  );

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        class={cn(
          `min-w-8rem bg-popover text-popover-foreground
          data-[expanded]:animate-in data-[closed]:animate-out
          data-[closed]:fade-out-0 data-[expanded]:fade-in-0
          data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 z-50
          overflow-hidden rounded-lg border p-1 shadow-md`,
          local.class,
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
};

type dropdownMenuCheckboxItemProps<
  T extends ValidComponent = "div",
> = ParentProps<
  DropdownMenuCheckboxItemProps<T> & {
    class?: string;
  }
>;

export const DropdownMenuCheckboxItem = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<
    T,
    dropdownMenuCheckboxItemProps<T>
  >,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuCheckboxItemProps,
    ["class", "children"],
  );

  return (
    <DropdownMenuPrimitive.CheckboxItem
      class={cn(
        `focus:bg-accent focus:text-accent-foreground relative flex
        cursor-default items-center rounded-sm py-1.5 pr-2 pl-8
        text-sm transition-colors outline-none select-none
        data-[disabled]:pointer-events-none
        data-[disabled]:opacity-50`,
        local.class,
      )}
      {...rest}
    >
      <DropdownMenuPrimitive.ItemIndicator
        class="absolute left-2 inline-flex h-4 w-4 items-center
          justify-center"
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
            d="m5 12l5 5L20 7"
          />
          <title>Checkbox</title>
        </svg>
      </DropdownMenuPrimitive.ItemIndicator>
      {props.children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
};

type dropdownMenuRadioItemProps<
  T extends ValidComponent = "div",
> = ParentProps<
  DropdownMenuRadioItemProps<T> & {
    class?: string;
  }
>;

export const DropdownMenuRadioItem = <
  T extends ValidComponent = "div",
>(
  props: PolymorphicProps<T, dropdownMenuRadioItemProps<T>>,
) => {
  const [local, rest] = splitProps(
    props as dropdownMenuRadioItemProps,
    ["class", "children"],
  );

  return (
    <DropdownMenuPrimitive.RadioItem
      class={cn(
        `focus:bg-accent focus:text-accent-foreground relative flex
        cursor-default items-center rounded-sm py-1.5 pr-2 pl-8
        text-sm transition-colors outline-none select-none
        data-[disabled]:pointer-events-none
        data-[disabled]:opacity-50`,
        local.class,
      )}
      {...rest}
    >
      <DropdownMenuPrimitive.ItemIndicator
        class="absolute left-2 inline-flex h-4 w-4 items-center
          justify-center"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          class="h-2 w-2"
        >
          <g
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
          >
            <path d="M0 0h24v24H0z" />
            <path
              fill="currentColor"
              d="M7 3.34a10 10 0 1 1-4.995 8.984L2 12l.005-.324A10 10 0 0 1 7 3.34"
            />
          </g>
          <title>Radio</title>
        </svg>
      </DropdownMenuPrimitive.ItemIndicator>
      {props.children}
    </DropdownMenuPrimitive.RadioItem>
  );
};
