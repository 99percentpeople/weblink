import { onCleanup, onMount, Show } from "solid-js";
import { ListTodo } from "lucide-solid";
import { t } from "@/i18n";
import { useAppState } from "@/libs/state/app-state-context";
import { createDialog } from "@/components/dialogs/dialog";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import {
  OPEN_CLIENT_INFO_DIALOG_EVENT,
  type OpenClientInfoDialogDetail,
} from "@/components/dialogs/client-info-dialog-events";
import { TaskList } from "@/components/task-list";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Navigation entry only. Task state lives in AppStateProvider. */
export function createTaskCenterDialog() {
  const details = clientInfoDialog();
  const dialog = createDialog({
    class:
      "h-[min(40rem,calc(100dvh-2rem))] sm:max-w-3xl [&>[data-slot=dialog-body]]:flex [&>[data-slot=dialog-body]]:flex-1 [&>[data-slot=dialog-body]]:overflow-hidden",
    title: () => t("tasks.title"),
    content: () => (
      <TaskList
        onInspect={(peerId, speed) => {
          dialog.close();
          void details.open(
            peerId,
            speed ? "speed" : "session",
          );
        }}
      />
    ),
  });

  onMount(() => {
    const openClientInfo = (event: Event) => {
      const detail = (
        event as CustomEvent<OpenClientInfoDialogDetail>
      ).detail;
      if (!detail) return;
      dialog.close();
      void details.open(detail.clientId, detail.tab);
    };

    window.addEventListener(
      OPEN_CLIENT_INFO_DIALOG_EVENT,
      openClientInfo,
    );
    onCleanup(() =>
      window.removeEventListener(
        OPEN_CLIENT_INFO_DIALOG_EVENT,
        openClientInfo,
      ),
    );
  });

  return dialog;
}

export function TaskCenter(props: {
  placement: "bottom" | "right";
}) {
  const app = useAppState();
  const dialog = createTaskCenterDialog();
  return (
    <Tooltip placement={props.placement}>
      <TooltipTrigger
        type="button"
        aria-label={t("tasks.title")}
        class="text-foreground/60 hover:text-foreground/80
          focus-visible:ring-ring relative rounded-md
          transition-colors focus-visible:ring-2
          focus-visible:outline-none"
        onClick={() => void dialog.open()}
      >
        <ListTodo class="size-8" aria-hidden="true" />
        <Show when={app.tasks.activeCount() > 0}>
          <span
            class="bg-primary text-primary-foreground absolute -top-1 -right-1
              min-w-4 rounded-full px-1 text-center text-[10px] leading-4
              tabular-nums"
            aria-label={t("tasks.active_count", {
              count: app.tasks.activeCount(),
            })}
          >
            {app.tasks.activeCount() > 99
              ? "99+"
              : app.tasks.activeCount()}
          </span>
        </Show>
      </TooltipTrigger>
      <TooltipContent>{t("tasks.title")}</TooltipContent>
    </Tooltip>
  );
}
