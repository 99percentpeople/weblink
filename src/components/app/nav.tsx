import { cn } from "@/libs/cn";
import { TaskCenter } from "./task-center";
import { A, useLocation } from "@solidjs/router";
import {
  ComponentProps,
  createEffect,
  createMemo,
  splitProps,
} from "solid-js";
import {
  IconFolder,
  IconForum,
  IconMonitor,
  IconSettings,
} from "../icons";
import { t } from "@/i18n";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import { createIsMobile } from "@/libs/hooks/create-mobile";

export const linkClasses = cn(
  "text-foreground/60 [&:not(&[aria-current])]:hover:text-foreground/80 aria-[current]:text-foreground transition-colors font-semibold",
);

export default function Nav(props: ComponentProps<"nav">) {
  const location = useLocation();
  const [local, other] = splitProps(props, ["class"]);
  const isMobile = createIsMobile();
  const placement = createMemo(() =>
    isMobile() ? "bottom" : "right",
  );
  const active = (path: string) =>
    location.pathname.startsWith(path)
      ? "text-foreground"
      : "";
  return (
    <nav class={cn("flex gap-2", local.class)} {...other}>
      <Tooltip placement={placement()}>
        <TooltipTrigger
          as={A}
          href="/"
          aria-label={t("common.nav.chat")}
          class={cn(
            linkClasses,
            active("/client"),
            active("/conversation"),
          )}
        >
          <IconForum class="size-8" />
        </TooltipTrigger>
        <TooltipContent>
          {t("common.nav.chat")}
        </TooltipContent>
      </Tooltip>
      <Tooltip placement={placement()}>
        <TooltipTrigger
          as={A}
          href="/video"
          aria-label={t("meeting.title")}
          class={cn(linkClasses)}
        >
          <IconMonitor class="size-8" />
        </TooltipTrigger>
        <TooltipContent>
          {t("common.nav.screen_sharing")}
        </TooltipContent>
      </Tooltip>
      <Tooltip placement={placement()}>
        <TooltipTrigger
          as={A}
          href="/file"
          aria-label={t("nav.file_cache")}
          class={cn(linkClasses)}
        >
          <IconFolder class="size-8" />
        </TooltipTrigger>
        <TooltipContent>
          {t("common.nav.file_cache")}
        </TooltipContent>
      </Tooltip>
      <TaskCenter placement={placement()} />
      <Tooltip placement={placement()}>
        <TooltipTrigger
          as={A}
          href="/setting"
          aria-label={t("nav.settings")}
          class={cn(linkClasses)}
        >
          <IconSettings class="size-8" />
        </TooltipTrigger>
        <TooltipContent>
          {t("common.nav.settings")}
        </TooltipContent>
      </Tooltip>
    </nav>
  );
}
