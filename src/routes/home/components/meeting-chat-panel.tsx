import { Show } from "solid-js";
import { MessageSquare } from "lucide-solid";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { ConversationView } from "@/components/conversations/conversation-view";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";

export function MeetingChatPanel(props: {
  conversationId?: string;
  split: boolean;
  browsing: boolean;
  onBack(): void;
  onSelect(id: string): void;
}) {
  const listOnly = () => props.browsing && !props.split;
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          class={cn(
            `flex min-h-0 flex-none overflow-hidden transition-[width]
            duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]`,
            props.split
              ? "w-60"
              : listOnly()
                ? "w-full"
                : "w-0",
          )}
        >
          <AnimatePresence when={props.split || listOnly()}>
            <Motion.div
              class={cn(
                "flex min-h-0 w-full min-w-0 overflow-hidden",
                !listOnly() && "border-r",
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <ConversationSidebar
                selectedId={props.conversationId}
                onSelect={props.onSelect}
              />
            </Motion.div>
          </AnimatePresence>
        </div>
        <Show when={!listOnly()}>
          <Motion.div
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
          >
            <Show
              when={props.conversationId}
              fallback={
                <div
                  class="text-muted-foreground flex flex-1 flex-col items-center
                    justify-center gap-3.5 p-[30px] text-center text-[13px]"
                >
                  <MessageSquare class="size-[30px] opacity-55" />
                  <p>{t("meeting.select_conversation")}</p>
                </div>
              }
            >
              {(id) => (
                <ConversationView
                  conversationId={id()}
                  embedded
                  onBack={
                    props.split ? undefined : props.onBack
                  }
                />
              )}
            </Show>
          </Motion.div>
        </Show>
      </div>
    </div>
  );
}
