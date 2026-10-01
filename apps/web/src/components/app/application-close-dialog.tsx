import type {
  NativeApplication,
  NativeCloseRequest,
  NativeCloseResponse,
  NativeCloseSession,
} from "@weblink/platform";
import {
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import {
  Checkbox,
  CheckboxControl,
  CheckboxLabel,
} from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { rememberApplicationCloseBehavior } from "@/options";

export function ApplicationCloseDialog(props: {
  application: NativeApplication;
}) {
  const [request, setRequest] =
    createSignal<NativeCloseRequest>();
  const [remember, setRemember] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  let subscription: Promise<NativeCloseSession> | undefined;

  onMount(() => {
    subscription = props.application.watchCloseRequests(
      (next) => {
        if (disposed || next.id === request()?.id) return;
        setRemember(false);
        setFailed(false);
        setRequest(next);
      },
    );
    void subscription.catch((error) => {
      console.error(
        "[Application] could not watch window close",
        error,
      );
    });
  });
  onCleanup(() => {
    disposed = true;
    void subscription
      ?.then((session) => session.close())
      .catch((error) => {
        console.error(
          "[Application] could not release close watcher",
          error,
        );
      });
  });

  const respond = async (response: NativeCloseResponse) => {
    const current = request();
    if (!current || busy() || disposed) return;
    setBusy(true);
    setFailed(false);
    try {
      const session = await subscription;
      if (!session || disposed) return;
      const save = remember() && response !== "cancel";
      if (save) {
        rememberApplicationCloseBehavior(response);
      }
      await session.respond(current.id, response, save);
      if (!disposed && request()?.id === current.id)
        setRequest(undefined);
    } catch (error) {
      console.error(
        "[Application] could not complete window close",
        error,
      );
      if (!disposed) setFailed(true);
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!request()}
      onOpenChange={(open) => {
        if (!open) void respond("cancel");
      }}
    >
      <DialogContent class="max-w-md" aria-busy={busy()}>
        <DialogHeader>
          <DialogTitle>
            {t("setting.application.close_confirm_title")}
          </DialogTitle>
          <DialogDescription>
            {t(
              request()?.trayAvailable
                ? "setting.application.close_confirm_description"
                : "setting.application.close_confirm_exit_description",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-3">
          <Checkbox
            class="flex items-center gap-2"
            checked={remember()}
            onChange={setRemember}
            disabled={busy()}
          >
            <CheckboxControl />
            <CheckboxLabel class="text-sm">
              {t(
                "setting.application.remember_close_choice",
              )}
            </CheckboxLabel>
          </Checkbox>
          <Show when={failed()}>
            <p
              role="alert"
              class="text-destructive text-sm"
            >
              {t("setting.application.close_failed")}
            </p>
          </Show>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy()}
            onClick={() => void respond("cancel")}
          >
            {t("common.action.cancel")}
          </Button>
          <Button
            variant={
              request()?.trayAvailable
                ? "secondary"
                : "default"
            }
            disabled={busy()}
            onClick={() => void respond("exit")}
          >
            {t("setting.application.close_behavior.exit")}
          </Button>
          <Show when={request()?.trayAvailable}>
            <Button
              disabled={busy()}
              onClick={() => void respond("tray")}
            >
              {t("setting.application.close_behavior.tray")}
            </Button>
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
