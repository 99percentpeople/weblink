import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as SliderPrimitive from "@kobalte/core/slider";

import { cn } from "@/libs/cn";
import { Label } from "@/components/ui/label";
import "./slider.css";

type SliderRootProps<T extends ValidComponent = "div"> =
  SliderPrimitive.SliderRootProps<T> & {
    class?: string | undefined;
  };

const Slider = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SliderRootProps<T>>,
) => {
  const [local, others] = splitProps(
    props as SliderRootProps,
    ["class"],
  );
  return (
    <SliderPrimitive.Root
      class={cn(
        `ui-slider relative flex w-full min-w-0 touch-none flex-col
        items-center gap-2 select-none`,
        local.class,
      )}
      {...others}
    />
  );
};

type SliderTrackProps<T extends ValidComponent = "div"> =
  SliderPrimitive.SliderTrackProps<T> & {
    class?: string | undefined;
  };

const SliderTrack = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SliderTrackProps<T>>,
) => {
  const [local, others] = splitProps(
    props as SliderTrackProps,
    ["class"],
  );
  return (
    <SliderPrimitive.Track
      class={cn("ui-slider-track", local.class)}
      {...others}
    />
  );
};

type SliderFillProps<T extends ValidComponent = "div"> =
  SliderPrimitive.SliderFillProps<T> & {
    class?: string | undefined;
  };

const SliderFill = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SliderFillProps<T>>,
) => {
  const [local, others] = splitProps(
    props as SliderFillProps,
    ["class"],
  );
  return (
    <SliderPrimitive.Fill
      class={cn("ui-slider-fill", local.class)}
      {...others}
    />
  );
};

type SliderThumbProps<T extends ValidComponent = "span"> =
  SliderPrimitive.SliderThumbProps<T> & {
    class?: string | undefined;
    children?: JSX.Element;
  };

const SliderThumb = <T extends ValidComponent = "span">(
  props: PolymorphicProps<T, SliderThumbProps<T>>,
) => {
  const [local, others] = splitProps(
    props as SliderThumbProps,
    ["class", "children"],
  );
  return (
    <SliderPrimitive.Thumb
      class={cn("ui-slider-thumb", local.class)}
      {...others}
    >
      {local.children}
      <SliderPrimitive.Input />
    </SliderPrimitive.Thumb>
  );
};

const SliderLabel = <T extends ValidComponent = "label">(
  props: PolymorphicProps<
    T,
    SliderPrimitive.SliderLabelProps<T> & {
      class?: string;
    }
  >,
) => {
  const [local, others] = splitProps(
    props as SliderPrimitive.SliderLabelProps & {
      class?: string;
    },
    ["class"],
  );
  return (
    <SliderPrimitive.Label
      as={Label}
      class={cn("min-w-0 leading-snug", local.class)}
      {...others}
    />
  );
};

const SliderValueLabel = <
  T extends ValidComponent = "label",
>(
  props: PolymorphicProps<
    T,
    SliderPrimitive.SliderValueLabelProps<T> & {
      class?: string;
    }
  >,
) => {
  const [local, others] = splitProps(
    props as SliderPrimitive.SliderValueLabelProps & {
      class?: string;
    },
    ["class"],
  );
  return (
    <SliderPrimitive.ValueLabel
      as={Label}
      class={cn(
        `text-muted-foreground ml-auto shrink-0 text-sm leading-snug
        whitespace-nowrap tabular-nums sm:text-sm`,
        local.class,
      )}
      {...others}
    />
  );
};

export {
  Slider,
  SliderTrack,
  SliderFill,
  SliderThumb,
  SliderLabel,
  SliderValueLabel,
};
