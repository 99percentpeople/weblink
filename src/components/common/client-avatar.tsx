import { getInitials } from "@/libs/utils/name";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "../ui/avatar";
import { PolymorphicProps } from "@kobalte/core";
import { Image } from "@kobalte/core";
import { splitProps, ValidComponent } from "solid-js";
import { cn } from "@/libs/cn";

type ClientAvatarProps<T extends ValidComponent = "span"> =
  PolymorphicProps<
    T,
    Image.ImageRootProps<T> & {
      class?: string | undefined;
      name: string;
      avatar?: string;
    }
  >;

export const ClientAvatar = <
  T extends ValidComponent = "span",
>(
  props: ClientAvatarProps<T>,
) => {
  const [local, rest] = splitProps(
    props as ClientAvatarProps,
    ["name", "avatar", "class"],
  );
  return (
    <Avatar class={cn(local.class)} {...rest}>
      <AvatarImage src={local.avatar ?? undefined} />
      <AvatarFallback seed={local.name}>
        {getInitials(local.name)}
      </AvatarFallback>
    </Avatar>
  );
};
