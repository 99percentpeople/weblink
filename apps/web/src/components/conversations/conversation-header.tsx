import { Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { ChevronLeft } from "lucide-solid";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import { getInitials } from "@/libs/utils/name";
import { t } from "@/i18n";
import { ConversationBackButton } from "./conversation-back-button";

export function ConversationHeader(props: {
  title: string;
  subtitle: string;
  avatar?: string | null;
  icon?: JSX.Element;
  actions?: JSX.Element;
  embedded?: boolean;
  onBack?: () => void;
  class?: string;
  "data-slot"?: string;
}) {
  return (
    <header
      data-slot={
        props["data-slot"] ?? "conversation-header"
      }
      class={cn(
        `border-border bg-background/80 flex w-full shrink-0
        items-center gap-2 border-b p-3 backdrop-blur`,
        props.class,
      )}
    >
      <Show when={props.onBack}>
        {(onBack) => (
          <ConversationBackButton onClick={onBack()} />
        )}
      </Show>
      <Show when={!props.embedded && !props.onBack}>
        <Button
          as={A}
          href="/"
          size="icon"
          variant="ghost"
          aria-label={t("404.home")}
        >
          <ChevronLeft class="size-5" />
        </Button>
      </Show>
      <Avatar class="size-9">
        <AvatarImage src={props.avatar ?? undefined} />
        <AvatarFallback
          seed={props.icon ? undefined : props.title}
          class={cn(
            "text-xs",
            props.icon && "bg-primary/10 text-primary",
          )}
        >
          {props.icon ?? getInitials(props.title)}
        </AvatarFallback>
      </Avatar>
      <div class="min-w-0 flex-1">
        <h2
          class="truncate text-sm font-semibold"
          title={props.title}
        >
          {props.title}
        </h2>
        <p class="text-muted-foreground truncate text-xs">
          {props.subtitle}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        {props.actions}
      </div>
    </header>
  );
}
