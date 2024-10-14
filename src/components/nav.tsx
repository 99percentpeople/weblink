import { cn } from "@/libs/cn";
import { A, useLocation } from "@solidjs/router";
import { ComponentProps, splitProps } from "solid-js";
import {
  IconFolder,
  IconForum,
  IconMeetingRoom,
  IconSettings,
} from "./icons";

export const linkClasses = cn(
  "text-foreground/60 hover:text-foreground/80 aria-[current]:text-foreground transition-colors font-semibold",
);

export default function Nav(props: ComponentProps<"nav">) {
  const location = useLocation();
  const active = (path: string) =>
    path == location.pathname
      ? "border-sky-600"
      : "border-transparent hover:border-sky-600";
  const [local, other] = splitProps(props, ["class"]);
  return (
    <nav class={cn("flex gap-2", local.class)} {...other}>
      <A href="/" class={cn(linkClasses, active("/"))}>
        <IconForum class="size-8" />
      </A>
      <A
        href="/video"
        class={cn(linkClasses, active("/video"))}
      >
        <IconMeetingRoom class="size-8" />
      </A>
      <A
        href="/file"
        class={cn(linkClasses, active("/file"))}
      >
        <IconFolder class="size-8" />
      </A>
      <A
        href="/setting"
        class={cn(linkClasses, active("/setting"))}
      >
        <IconSettings class="size-8" />
      </A>
    </nav>
  );
}
