import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core";
import * as SwitchPrimitive from "@kobalte/core/switch";

import { cn } from "@/libs/cn";

type SwitchProps = SwitchPrimitive.SwitchRootProps & {
  class?: string;
};

const Switch = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SwitchProps>,
) => {
  const [local, others] = splitProps(props as SwitchProps, [
    "class",
  ]);
  return (
    <SwitchPrimitive.Root
      // Keep the hidden input inside its row when the browser scrolls it into focus.
      class={cn("relative", local.class)}
      {...others}
    />
  );
};
const SwitchDescription = SwitchPrimitive.Description;
const SwitchErrorMessage = SwitchPrimitive.ErrorMessage;

type SwitchControlProps =
  SwitchPrimitive.SwitchControlProps & {
    class?: string | undefined;
    children?: JSX.Element;
  };

const SwitchControl = <T extends ValidComponent = "input">(
  props: PolymorphicProps<T, SwitchControlProps>,
) => {
  const [local, others] = splitProps(
    props as SwitchControlProps,
    ["class", "children"],
  );
  return (
    <>
      <SwitchPrimitive.Input
        class={cn(
          `[&:focus-visible+div]:ring-ring
          [&:focus-visible+div]:ring-offset-background
          [&:focus-visible+div]:outline-none
          [&:focus-visible+div]:ring-2
          [&:focus-visible+div]:ring-offset-2`,
          local.class,
        )}
      />
      <SwitchPrimitive.Control
        class={cn(
          `bg-input data-[checked]:bg-primary inline-flex h-6 w-11
          shrink-0 cursor-pointer items-center rounded-full border-2
          border-transparent
          transition-[color,background-color,box-shadow]
          data-[disabled]:cursor-not-allowed
          data-[disabled]:opacity-50`,
          local.class,
        )}
        {...others}
      >
        {local.children}
      </SwitchPrimitive.Control>
    </>
  );
};

type SwitchThumbProps = SwitchPrimitive.SwitchThumbProps & {
  class?: string | undefined;
};

const SwitchThumb = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SwitchThumbProps>,
) => {
  const [local, others] = splitProps(
    props as SwitchThumbProps,
    ["class"],
  );
  return (
    <SwitchPrimitive.Thumb
      class={cn(
        `bg-background pointer-events-none block size-5 translate-x-0
        rounded-full shadow-lg ring-0 transition-transform
        data-[checked]:translate-x-5`,
        local.class,
      )}
      {...others}
    />
  );
};

type SwitchLabelProps = SwitchPrimitive.SwitchLabelProps & {
  class?: string | undefined;
};

const SwitchLabel = <T extends ValidComponent = "label">(
  props: PolymorphicProps<T, SwitchLabelProps>,
) => {
  const [local, others] = splitProps(
    props as SwitchLabelProps,
    ["class"],
  );
  return (
    <SwitchPrimitive.Label
      class={cn(
        `text-sm leading-none data-[disabled]:cursor-not-allowed
        data-[disabled]:opacity-70 sm:text-base`,
        local.class,
      )}
      {...others}
    />
  );
};

export {
  Switch,
  SwitchControl,
  SwitchThumb,
  SwitchLabel,
  SwitchDescription,
  SwitchErrorMessage,
};
