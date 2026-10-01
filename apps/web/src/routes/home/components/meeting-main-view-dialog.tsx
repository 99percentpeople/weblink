import { createSignal, onCleanup } from "solid-js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";

export function createMeetingMainViewConfirmation() {
  const [mount, setMount] = createSignal<HTMLElement>();
  const [request, setRequest] = createSignal<{
    resolve(confirmed: boolean): void;
  }>();
  const respond = (confirmed: boolean) => {
    const current = request();
    setRequest(undefined);
    current?.resolve(confirmed);
  };
  onCleanup(() => respond(false));
  return {
    confirm: (mount?: HTMLElement) =>
      new Promise<boolean>((resolve) => {
        respond(false);
        setMount(mount);
        setRequest({ resolve });
      }),
    dismiss: () => respond(false),
    Dialog: () => (
      <Dialog
        open={!!request()}
        onOpenChange={(open) => {
          if (!open) respond(false);
        }}
      >
        <DialogContent
          portalMount={mount()}
          class="max-w-md"
        >
          <DialogHeader>
            <DialogTitle>
              {t("meeting.leave_main_title")}
            </DialogTitle>
            <DialogDescription>
              {t("meeting.leave_main_description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => respond(false)}
            >
              {t("common.action.cancel")}
            </Button>
            <Button onClick={() => respond(true)}>
              {t("meeting.leave_main_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
}
