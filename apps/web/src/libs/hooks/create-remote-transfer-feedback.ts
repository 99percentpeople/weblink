import {
  createEffect,
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
  event?: string;
  cancelling?: boolean;
}

/** Present existing remote content tasks; text and single-chunk transfers stay quiet. */
export function createRemoteTransferFeedback(options: {
  tasks: Accessor<TaskListItem[]>;
  notifications: Pick<
    NotificationService,
    "show" | "dismiss" | "update"
  >;
  openTasks(): void;
}) {
  const notices = new Map<string, Notice>();
  const toastId = (id: string) =>
    `clipboard-transfer:${id}`;
  const dismiss = (notice: Notice) => {
    if (notice.event)
      options.notifications.dismiss(notice.event);
    notice.event = undefined;
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
    const id = `${toastId(task.id)}:${active ? "active" : task.status}`;
    if (notice.event === id) {
      options.notifications.update(
        id,
        Date.now() + 10 * 60_000,
      );
      return;
    }
    dismiss(notice);
    notice.event = id;
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
      present() {
        let closed = false;
        let content: string | undefined;
        const render = () => {
          if (closed) return;
          const latest = current(task.id);
          if (
            !latest ||
            !isRemoteContentTransferTask(latest)
          )
            return;
          if (active) {
            const heading = transferText(
              latest,
              latest.status === "finalizing"
                ? "finalizing"
                : latest.kind === "file-send"
                  ? "sending"
                  : "receiving",
            );
            const description = `${formatBtyeSize(latest.bytes)} / ${formatBtyeSize(latest.total)}`;
            const next = `${heading}\n${description}`;
            if (content === next) return;
            content = next;
            toast.loading(heading, {
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
          }
        };
        render();
        return {
          update: active ? render : undefined,
          dismiss() {
            closed = true;
            toast.dismiss(toastId(task.id));
          },
        };
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
    untrack(() => {
      const ids = new Set(tasks.map((task) => task.id));
      for (const [id, notice] of notices) {
        if (ids.has(id)) continue;
        dismiss(notice);
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
          notify(task, notice, title, true);
        } else if (previous !== task.status) {
          dismiss(notice);
          if (
            task.status !== "completed" &&
            task.status !== "failed"
          ) {
            continue;
          }
          const title = transferText(
            task,
            task.status === "completed"
              ? "completed"
              : "failed",
          );
          notify(task, notice, title, false);
        }
      }
    });
  });
  onCleanup(() => {
    for (const notice of notices.values()) dismiss(notice);
    notices.clear();
  });
}
