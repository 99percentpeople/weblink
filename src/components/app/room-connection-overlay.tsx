import * as Dialog from "@kobalte/core/dialog";
import { MonitorUp } from "lucide-solid";
import { Button } from "@/components/ui/button";
import { useRoomActions } from "./room-actions";
import { useAppState } from "@/libs/state/app-state-context";
import { t } from "@/i18n";

export function RoomConnectionOverlay() {
  const state = useAppState();
  const actions = useRoomActions();
  return (
    <Dialog.Root open={state.roomConflict()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="bg-background/90 fixed inset-0 z-[100] backdrop-blur-md" />
        <Dialog.Content
          class="fixed inset-0 z-[100] flex h-dvh flex-col items-center
            justify-center gap-4 overflow-y-auto p-6 text-center
            outline-none"
          onEscapeKeyDown={(event) =>
            event.preventDefault()
          }
          onInteractOutside={(event) =>
            event.preventDefault()
          }
          aria-busy={actions.busy()}
        >
          <MonitorUp class="text-muted-foreground size-10" />
          <Dialog.Title class="text-xl font-semibold">
            {t("room_connection.title")}
          </Dialog.Title>
          <Dialog.Description class="text-muted-foreground max-w-md text-sm">
            {t("room_connection.description")}
          </Dialog.Description>
          <Button
            disabled={actions.busy()}
            onClick={() => void actions.takeover()}
          >
            {t(
              actions.busy()
                ? "room_connection.switching"
                : "room_connection.switch_here",
            )}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
