import { Show } from "solid-js";
import { MessageSquare } from "lucide-solid";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { ConversationView } from "@/components/conversations/conversation-view";
import { SidebarBrowser } from "@/components/common/sidebar-browser";
import { t } from "@/i18n";

export function MeetingChatPanel(props: {
  conversationId?: string;
  split: boolean;
  browsing: boolean;
  onBack(): void;
  onSelect(id: string): void;
  onDetailExitComplete?: () => void;
}) {
  return (
    <SidebarBrowser
      split={props.split}
      browsing={props.browsing}
      onDetailExitComplete={props.onDetailExitComplete}
      list={
        <ConversationSidebar
          selectedId={props.conversationId}
          onSelect={props.onSelect}
        />
      }
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
            onBack={props.split ? undefined : props.onBack}
          />
        )}
      </Show>
    </SidebarBrowser>
  );
}
