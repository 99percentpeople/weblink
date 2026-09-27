import { userErrorMessage } from "@/libs/user-error";
import { Show } from "solid-js";
import { X } from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import {
  Checkbox,
  CheckboxControl,
  CheckboxLabel,
} from "@/components/ui/checkbox";
import {
  FileTransferDetails,
  FileTransferIndicator,
} from "@/components/conversations/file-transfer-indicator";
import {
  isActiveTask,
  type SharedFileTask,
} from "@/libs/application/task-service";
import type { ProtocolFileMetadata } from "@/libs/domain/protocol";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";
import { FileThumbnail } from "./file-list";

export function SharedFileRow(props: {
  file: ProtocolFileMetadata;
  task?: SharedFileTask;
  selected: boolean;
  connected: boolean;
  canGet: boolean;
  available: boolean;
  localFile?: File;
  selectable: boolean;
  onSelect(selected: boolean): void;
  onGet(): void;
  onPreview(file: File): void;
}) {
  const transfer = () =>
    !props.available &&
    props.task &&
    !["completed", "cancelled"].includes(props.task.status)
      ? props.task
      : undefined;
  const action = () => {
    const task = props.task;
    if (!task) return;
    if (isActiveTask(task) && task.canPause) return "pause";
    if (
      task.canResume &&
      ["paused", "failed"].includes(task.status)
    )
      return "resume";
  };
  const control = () => {
    if (action() === "pause") props.task?.pause();
    else
      void props.task
        ?.resume()
        .catch((error) =>
          toast.error(
            userErrorMessage(error, "errors.file_failed"),
          ),
        );
  };
  return (
    <li
      class={cn(
        `flex min-w-0 items-center gap-3 rounded-md px-2 py-3
        transition-colors`,
        props.selected
          ? "bg-primary/10"
          : "hover:bg-muted/50",
      )}
    >
      <Checkbox
        checked={props.selected}
        disabled={!props.selectable}
        onChange={props.onSelect}
      >
        <CheckboxControl />
        <CheckboxLabel class="sr-only">
          {props.file.fileName}
        </CheckboxLabel>
      </Checkbox>
      <Show
        when={transfer()}
        fallback={
          <FileThumbnail
            file={{
              ...props.file,
              file: props.localFile,
              mimetype:
                props.file.mimetype ??
                props.localFile?.type,
            }}
          />
        }
      >
        {(task) => (
          <FileTransferIndicator
            received={
              ["waiting", "finalizing"].includes(
                task().status,
              )
                ? undefined
                : task().bytes
            }
            total={task().total}
            busy={isActiveTask(task())}
            action={action()}
            disabled={
              action() === "resume" && !props.connected
            }
            onAction={control}
          />
        )}
      </Show>
      <button
        type="button"
        class="min-w-0 flex-1 text-left"
        disabled={!props.localFile}
        onClick={() => {
          const file = props.localFile;
          if (file) props.onPreview(file);
        }}
      >
        <span
          class="block truncate text-sm font-medium"
          title={props.file.fileName}
        >
          {props.file.fileName}
        </span>
        <span class="text-muted-foreground mt-1 block text-xs">
          <Show
            when={transfer()}
            fallback={formatBtyeSize(props.file.fileSize)}
          >
            {(task) => (
              <FileTransferDetails
                status={t(`tasks.status.${task().status}`)}
                received={task().bytes}
                total={task().total}
                live={task().status === "running"}
                error={task().error}
              />
            )}
          </Show>
        </span>
      </button>
      <Show when={transfer()}>
        <Button
          size="icon"
          variant="ghost"
          class="size-8 shrink-0"
          aria-label={t("common.action.cancel")}
          title={t("common.action.cancel")}
          onClick={() =>
            void props.task
              ?.cancel()
              .catch((error) =>
                toast.error(
                  userErrorMessage(
                    error,
                    "errors.file_failed",
                  ),
                ),
              )
          }
        >
          <X class="size-4" />
        </Button>
      </Show>
      <Show when={!props.available && !transfer()}>
        <Button
          size="sm"
          variant="ghost"
          disabled={!props.canGet}
          onClick={props.onGet}
        >
          {t("shared_files.get")}
        </Button>
      </Show>
    </li>
  );
}
