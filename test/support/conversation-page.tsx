import { useParams } from "@solidjs/router";
import { ConversationView } from "@/components/conversations/conversation-view";
import { createMemo } from "solid-js";

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const id = createMemo(() => {
    try {
      return decodeURIComponent(params.id);
    } catch {
      return "";
    }
  });
  return <ConversationView conversationId={id()} />;
}
