import {
  createRoot,
  createSignal,
  createUniqueId,
  Show,
} from "solid-js";
import { toast } from "solid-sonner";
import {
  createFileSaveProgress,
  type FileSaveProgress,
  type StoredFile,
} from "@weblink/platform";
import {
  ToastContent,
  ToastDismissButton,
} from "@/components/ui/toast-content";
import { Progress } from "@/components/ui/progress";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";

interface FileSaveState {
  status:
    | "saving"
    | "waiting"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed";
  progress: FileSaveProgress;
  error?: string;
}

export function showFileSaveProgress(
  files: readonly StoredFile[],
  controller: AbortController,
) {
  return createRoot((dispose) => {
    const id = `file-save-progress:${createUniqueId()}`;
    const [state, setState] = createSignal<FileSaveState>({
      status: "saving",
      progress: createFileSaveProgress(files),
    });
    let closed = false;
    let finished = false;
    const cancelling = () => {
      if (!closed && !finished)
        setState((value) => ({
          ...value,
          status: "cancelling",
        }));
    };
    controller.signal.addEventListener("abort", cancelling);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      controller.signal.removeEventListener(
        "abort",
        cancelling,
      );
      dispose();
    };
    const dismiss = () => {
      if (closed) return;
      toast.dismiss(id);
      cleanup();
    };
    const content = () => (
      <FileSaveProgressContent
        state={state()}
        onCancel={() => controller.abort()}
        onDismiss={dismiss}
      />
    );
    const show = (duration: number) =>
      toast.message(content, {
        id,
        duration,
        dismissible: finished,
        closeButton: false,
        onAutoClose: cleanup,
        onDismiss: cleanup,
      });
    show(Infinity);
    const finish = (
      status: "completed" | "cancelled" | "failed",
      error?: string,
    ) => {
      if (closed || finished) return;
      finished = true;
      controller.signal.removeEventListener(
        "abort",
        cancelling,
      );
      setState((value) => ({ ...value, status, error }));
      show(4000);
    };
    return {
      dismiss,
      update(progress: FileSaveProgress) {
        if (!closed && !finished)
          setState((value) => ({ ...value, progress }));
      },
      setWaiting(waiting: boolean) {
        if (
          !closed &&
          !finished &&
          !controller.signal.aborted
        )
          setState((value) => ({
            ...value,
            status: waiting ? "waiting" : "saving",
          }));
      },
      finish(completed: boolean) {
        finish(completed ? "completed" : "cancelled");
      },
      fail(message: string) {
        finish("failed", message);
      },
    };
  });
}

function FileSaveProgressContent(props: {
  state: FileSaveState;
  onCancel(): void;
  onDismiss(): void;
}) {
  const active = () =>
    props.state.status === "saving" ||
    props.state.status === "waiting" ||
    props.state.status === "cancelling";
  const progress = () => props.state.progress;
  const percent = () => {
    const value = progress();
    const finished = value.savedFiles + value.skippedFiles;
    const fraction = value.totalBytes
      ? value.processedBytes / value.totalBytes
      : finished / Math.max(1, value.totalFiles);
    // The final bytes still need to commit before the batch can reach 100%.
    return Math.min(
      finished === value.totalFiles ? 100 : 99,
      Math.floor(fraction * 100),
    );
  };
  return (
    <ToastContent
      aria-label={t("file_save_progress.title")}
      status
      title={t(`file_save_progress.${props.state.status}`)}
      trailing={
        <>
          <span>{percent()}%</span>
          <Show
            when={active()}
            fallback={
              <ToastDismissButton
                aria-label={t("common.action.close")}
                title={t("common.action.close")}
                onClick={props.onDismiss}
              />
            }
          >
            <ToastDismissButton
              aria-label={t(
                "file_save_progress.cancel_remaining",
              )}
              title={t(
                "file_save_progress.cancel_remaining",
              )}
              disabled={props.state.status === "cancelling"}
              onClick={props.onCancel}
            />
          </Show>
        </>
      }
    >
      <Show when={active() && progress().fileIndex > 0}>
        <p class="truncate" title={progress().fileName}>
          {t("file_save_progress.current_file", {
            fileName: progress().fileName,
            index: progress().fileIndex,
            total: progress().totalFiles,
          })}
        </p>
      </Show>
      <Show when={active() && !progress().fileIndex}>
        <p>{t("file_save_progress.preparing")}</p>
      </Show>
      <Progress
        value={percent()}
        aria-label={t("file_save_progress.title")}
      />
      <div class="toast-meta">
        <span>
          {t("file_save_progress.counts", {
            saved: progress().savedFiles,
            skipped: progress().skippedFiles,
            total: progress().totalFiles,
          })}
        </span>
        <Show when={active() && progress().fileIndex > 0}>
          <span class="shrink-0 tabular-nums">
            {formatBtyeSize(progress().fileBytesWritten)} /{" "}
            {formatBtyeSize(progress().fileSize)}
          </span>
        </Show>
      </div>
      <Show when={props.state.error}>
        <p
          role="alert"
          class="text-destructive break-words"
        >
          {props.state.error}
        </p>
      </Show>
    </ToastContent>
  );
}
