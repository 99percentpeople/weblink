import { useNavigate, useParams } from "@solidjs/router";
import { createEffect, Show } from "solid-js";
import { ChatConversation } from "@/components/conversations/direct-conversation";
import { appState } from "@/libs/state/app-state";

export default function ClientPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  createEffect(() => {
    if (
      appState.message.status === "ready" &&
      !appState.message.clients.some(
        (client) => client.clientId === params.id,
      )
    ) {
      navigate("/", { replace: true });
    }
  });
  return (
    <Show when={params.id} keyed>
      {(clientId) => (
        <ChatConversation clientId={clientId} />
      )}
    </Show>
  );
}
