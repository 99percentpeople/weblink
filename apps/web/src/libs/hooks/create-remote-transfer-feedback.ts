import {
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import {
  isActiveTask,
  isRemoteContentTransferTask,
  type SharedFileTask,
  type TaskListItem,
  type TaskStatus,
} from "@/libs/application/task-service";
import type { NotificationService } from "@/libs/application/notifications/notification-service";
import { formatBtyeSize } from "@/libs/utils/format-filesize";

function transferText(
  task: SharedFileTask,
  key:
    | "details"
    | "sending"
    | "receiving"
    | "finalizing"
    | "completed"
    | "failed",
) {
  const prefix =
    task.origin === "drop"
      ? "remote_control.file_drop."
      : "remote_control.clipboard_transfer.";
  return t(`${prefix}${key}`);
}

interface Notice {
  status?: TaskStatus;
  toast?: string;
  notification?: string;
  cancelling?: boolean;
}

/** Present existing remote content tasks; text and single-chunk transfers stay quiet. */
export function createRemoteTransferFeedback(options: {
  tasks: Accessor<TaskListItem[]>;
  notifications?: Pick<
    NotificationService,
    "show" | "dismiss"
  >;
  openTasks(): void;
}) {
  const isForeground = () =>
    document.visibilityState === "visible" &&
    document.hasFocus();
  const [foreground, setForeground] =
    createSignal(isForeground());
  const life = new AbortController();
  const update = () => setForeground(isForeground());
  window.addEventListener("focus", update, {
    signal: life.signal,
  });
  window.addEventListener(
    "blur",
    () => setForeground(false),
    { signal: life.signal },
  );
  document.addEventListener("visibilitychange", update, {
    signal: life.signal,
  });
  const notices = new Map<string, Notice>();
  const toastId = (id: string) =>
    `clipboard-transfer:${id}`;
  const dismissToast = (id: string, notice: Notice) => {
    if (notice.toast) toast.dismiss(toastId(id));
    notice.toast = undefined;
  };
  const dismissNotification = (notice: Notice) => {
    if (notice.notification)
      options.notifications?.dismiss(notice.notification);
    notice.notification = undefined;
  };
  const current = (id: string) =>
    options.tasks().find((task) => task.id === id);
  const cancel = async (id: string) => {
    const task = current(id);
    const notice = notices.get(id);
    if (
      !task ||
      !notice ||
      notice.cancelling ||
      !isRemoteContentTransferTask(task) ||
      !isActiveTask(task)
    )
      return;
    notice.cancelling = true;
    try {
      await task.cancel();
    } catch (error) {
      console.warn(
        "Could not cancel remote transfer",
        error,
      );
    } finally {
      notice.cancelling = false;
    }
  };
  const notify = (
    task: SharedFileTask,
    notice: Notice,
    title: string,
    active: boolean,
  ) => {
    if (!options.notifications) return;
    const id = `${toastId(task.id)}:${active ? "active" : task.status}`;
    if (notice.notification === id) return;
    dismissNotification(notice);
    notice.notification = id;
    void options.notifications.show({
      category: "transfers",
      current: () => {
        const latest = current(task.id);
        return (
          !!latest &&
          (active
            ? isActiveTask(latest)
            : latest.status === task.status)
        );
      },
      notification: {
        id,
        title,
        body: transferText(task, "details"),
        expiresAt: Date.now() + 10 * 60_000,
        actions: active
          ? [
              {
                id: "cancel",
                title: t("common.action.cancel"),
              },
            ]
          : undefined,
      },
      async respond(action) {
        if (action.action === "cancel")
          await cancel(task.id);
        else if (action.action === "open")
          options.openTasks();
      },
    });
  };
  createEffect(() => {
    const tasks = options
      .tasks()
      .filter(isRemoteContentTransferTask);
    const front = foreground();
    untrack(() => {
      const ids = new Set(tasks.map((task) => task.id));
      for (const [id, notice] of notices) {
        if (ids.has(id)) continue;
        dismissToast(id, notice);
        dismissNotification(notice);
        notices.delete(id);
      }
      for (const task of tasks) {
        let notice = notices.get(task.id);
        // Restored/cleared history must never replay a completion notification.
        if (!notice && !isActiveTask(task)) continue;
        if (!notice) notices.set(task.id, (notice = {}));
        const previous = notice.status;
        notice.status = task.status;
        if (isActiveTask(task)) {
          const title = transferText(
            task,
            task.status === "finalizing"
              ? "finalizing"
              : task.kind === "file-send"
                ? "sending"
                : "receiving",
          );
          if (front) {
            dismissNotification(notice);
            const description = `${formatBtyeSize(task.bytes)} / ${formatBtyeSize(task.total)}`;
            const content = `${title}\n${description}`;
            if (notice.toast === content) continue;
            notice.toast = content;
            toast.loading(title, {
              id: toastId(task.id),
              description,
              duration: Infinity,
              dismissible: false,
              closeButton: false,
              action: {
                label: t("common.action.cancel"),
                onClick: () => void cancel(task.id),
              },
            });
          } else {
            dismissToast(task.id, notice);
            notify(task, notice, title, true);
          }
        } else if (previous !== task.status) {
          dismissNotification(notice);
          if (
            task.status !== "completed" &&
            task.status !== "failed"
          ) {
            dismissToast(task.id, notice);
            continue;
          }
          const title = transferText(
            task,
            task.status === "completed"
              ? "completed"
              : "failed",
          );
          if (front) {
            notice.toast = title;
            const show =
              task.status === "completed"
                ? toast.success
                : toast.error;
            show(title, {
              id: toastId(task.id),
              duration: 4000,
              dismissible: true,
              action: undefined,
              description: undefined,
            });
          } else {
            dismissToast(task.id, notice);
            notify(task, notice, title, false);
          }
        }
      }
    });
  });
  onCleanup(() => {
    life.abort();
    for (const [id, notice] of notices) {
      dismissToast(id, notice);
      dismissNotification(notice);
    }
    notices.clear();
  });
}
