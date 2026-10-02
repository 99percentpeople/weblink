import type { JSX, ValidComponent } from "solid-js";
import { createMemo, Show, splitProps } from "solid-js";

import * as ImagePrimitive from "@kobalte/core/image";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";

import { cn } from "@/libs/cn";
import { getAvatarFallbackImage } from "@/libs/utils/avatar";

type AvatarRootProps<T extends ValidComponent = "span"> =
  ImagePrimitive.ImageRootProps<T> & {
    class?: string | undefined;
  };

const Avatar = <T extends ValidComponent = "span">(
  props: PolymorphicProps<T, AvatarRootProps<T>>,
) => {
  const [local, others] = splitProps(
    props as AvatarRootProps,
    ["class"],
  );
  return (
    <ImagePrimitive.Root
      class={cn(
        "relative flex size-10 shrink-0 overflow-hidden rounded-full",
        local.class,
      )}
      {...others}
    />
  );
};

type AvatarImageProps<T extends ValidComponent = "img"> =
  ImagePrimitive.ImageImgProps<T> & {
    class?: string | undefined;
  };

const AvatarImage = <T extends ValidComponent = "img">(
  props: PolymorphicProps<T, AvatarImageProps<T>>,
) => {
  const [local, others] = splitProps(
    props as AvatarImageProps,
    ["class"],
  );
  return (
    <ImagePrimitive.Img
      class={cn("aspect-square size-full", local.class)}
      {...others}
    />
  );
};

type AvatarFallbackProps<
  T extends ValidComponent = "span",
> = ImagePrimitive.ImageFallbackProps<T> & {
  class?: string | undefined;
  seed?: string | undefined;
  children?: JSX.Element;
};

const AvatarFallback = <T extends ValidComponent = "span">(
  props: PolymorphicProps<T, AvatarFallbackProps<T>>,
) => {
  const [local, others] = splitProps(
    props as AvatarFallbackProps,
    ["class", "seed", "children"],
  );
  const image = createMemo(() =>
    local.seed !== undefined
      ? getAvatarFallbackImage(local.seed)
      : undefined,
  );
  return (
    <ImagePrimitive.Fallback
      class={cn(
        `bg-muted flex size-full select-none items-center
        justify-center rounded-full`,
        local.class,
      )}
      {...others}
    >
      <Show when={image()} fallback={local.children}>
        {(source) => (
          <>
            <img
              src={source()}
              alt=""
              aria-hidden="true"
              class="size-full"
            />
            <span class="sr-only">{local.children}</span>
          </>
        )}
      </Show>
    </ImagePrimitive.Fallback>
  );
};

export { Avatar, AvatarImage, AvatarFallback };
