import { createSignal, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { sessionService } from "@/libs/application/session-service";
import { appState } from "@/libs/state/app-state";
import { t } from "@/i18n";
export function RemoteControlStatus() {
  const host = sessionService.remoteControl;
  const pending = () => host.status().pending;
  const [busy, setBusy] = createSignal(false);
  const name = (id: string) =>
    appState.session.clientViewData[id]?.name ?? id;
  const respond = async (approve: boolean) => {
    const p = pending();
    if (!p || busy()) return;
    setBusy(true);
    try {
      await host.approve(p.consentId, approve);
    } catch (error) {
      console.warn(
        "Local remote-control confirmation failed",
        error,
      );
      toast.error(t("remote_control.approval_failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={!!pending()}
        onOpenChange={(open) => {
          if (!open) void respond(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("remote_control.request_title")}
            </DialogTitle>
            <DialogDescription>
              {t("remote_control.request_description", {
                name: pending()
                  ? name(pending()!.clientId)
                  : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <p class="text-muted-foreground text-sm">
            {t("remote_control.revoke_hint")}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() => void respond(false)}
            >
              {t("remote_control.decline")}
            </Button>
            <Button
              disabled={busy()}
              onClick={() => void respond(true)}
            >
              {t("remote_control.allow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Show when={host.status().clientId}>
        {(id) => (
          <div
            role="status"
            class="bg-background fixed bottom-4 left-1/2 z-50 flex
              max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3
              rounded-lg border px-4 py-3 text-sm shadow-lg"
          >
            <span>
              {t("remote_control.host_active", {
                name: name(id()),
              })}{" "}
              <span class="text-muted-foreground">
                Ctrl+Alt+Shift+F10
              </span>
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                void host
                  .revoke()
                  .catch(() =>
                    toast.error(
                      t("remote_control.approval_failed"),
                    ),
                  )
              }
            >
              {t("remote_control.revoke")}
            </Button>
          </div>
        )}
      </Show>
    </>
  );
}
