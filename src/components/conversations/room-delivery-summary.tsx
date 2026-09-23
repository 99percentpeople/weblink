import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { RotateCw } from "lucide-solid";
import { ClientAvatar } from "@/components/common/client-avatar";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import type { RoomMessage } from "@/libs/domain/message";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";
import { toast } from "solid-sonner";

export function RoomDeliverySummary(props: {
  message: RoomMessage;
}) {
  const state = useAppState();
  const [retrying, setRetrying] = createSignal(false);
  const deliveries = createMemo(() =>
    Object.entries(props.message.deliveries ?? {}),
  );
  const visibleDeliveries = createMemo(() =>
    deliveries().length > 4
      ? deliveries().slice(0, 3)
      : deliveries(),
  );
  const hiddenDeliveries = createMemo(() =>
    deliveries().slice(visibleDeliveries().length),
  );
  const getClient = (peer: string) =>
    appState.session.clientViewData[peer] ??
    appState.message.clients.find(
      (client) => client.clientId === peer,
    );
  const recipientLabel = (peer: string, status: string) =>
    `${getClient(peer)?.name ?? peer} · ${t(`conversations.delivery_${status}`)}`;
  const hiddenLabel = () =>
    hiddenDeliveries()
      .map(([peer, status]) => recipientLabel(peer, status))
      .join("\n");
  const delivered = () =>
    deliveries().filter(
      ([, status]) => status === "delivered",
    ).length;
  const failed = () =>
    deliveries().some(
      ([peer, status]) =>
        status === "failed" &&
        appState.session.clientViewData[peer]
          ?.messageChannel,
    );
  const retry = async () => {
    if (retrying()) return;
    setRetrying(true);
    try {
      await state.retryMessage(props.message);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Show when={deliveries().length}>
      <div
        class="text-muted-foreground flex max-w-24 shrink-0 items-center
          justify-end gap-1"
        data-slot="room-deliveries"
        role="group"
        aria-label={t("conversations.delivered_count", {
          count: delivered(),
          total: deliveries().length,
        })}
      >
        <div class="isolate flex max-w-16 min-w-0 justify-end -space-x-1.5">
          <For each={visibleDeliveries()}>
            {([peer, status]) => {
              const client = createMemo(() =>
                getClient(peer),
              );
              const name = () => client()?.name ?? peer;
              const label = () =>
                recipientLabel(peer, status);
              return (
                <ClientAvatar
                  name={name()}
                  avatar={client()?.avatar ?? undefined}
                  class={cn(
                    "relative size-5 shrink-0 border-2 text-[8px] hover:z-10",
                    status === "failed"
                      ? "border-destructive"
                      : "border-background",
                    status === "sending" && "opacity-50",
                    status === "unsupported" &&
                      "border-dashed opacity-40 grayscale",
                  )}
                  title={label()}
                  aria-label={label()}
                  role="img"
                  data-recipient-id={peer}
                  data-delivery-status={status}
                />
              );
            }}
          </For>
          <Show when={hiddenDeliveries().length}>
            <span
              class="bg-muted text-muted-foreground border-background relative
                flex size-5 shrink-0 items-center justify-center
                rounded-full border-2 text-[8px] font-medium"
              role="img"
              title={hiddenLabel()}
              aria-label={hiddenLabel()}
              data-slot="room-delivery-overflow"
            >
              +{hiddenDeliveries().length}
            </span>
          </Show>
        </div>
        <Show
          when={
            failed() &&
            props.message.conversationId ===
              state.activeRoomConversationId()
          }
        >
          <Button
            type="button"
            size="icon"
            variant="ghost"
            class="size-6 shrink-0 rounded-full"
            aria-label={t("conversations.retry_failed")}
            title={t("conversations.retry_failed")}
            disabled={retrying()}
            onClick={() => void retry()}
          >
            <RotateCw
              class="size-3"
              classList={{ "animate-spin": retrying() }}
            />
          </Button>
        </Show>
      </div>
    </Show>
  );
}
