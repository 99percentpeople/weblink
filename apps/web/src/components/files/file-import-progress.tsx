import {
  createRoot,
  createSignal,
  createUniqueId,
  Show,
} from "solid-js";
import { X } from "lucide-solid";
import { toast } from "solid-sonner";
import type { FileImportProgress } from "@/libs/application/file-library-service";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";

interface ImportState {
  ready: boolean;
  totalFiles: number;
  completedFiles: number;
  totalWork: number;
  completedWork: number;
  processedWork: number;
  fileName: string;
  fileSize: number;
  progress: FileImportProgress;
}

/** Each import owns its notice, including after the initiating view is disposed. */
export function showFileImportProgress(
  controller: AbortController,
) {
  return createRoot((dispose) => {
    const id = `file-import-progress:${createUniqueId()}`;
    const [state, setState] = createSignal<ImportState>({
      ready: false,
      totalFiles: 0,
      completedFiles: 0,
      totalWork: 0,
      completedWork: 0,
      processedWork: 0,
      fileName: "",
      fileSize: 0,
      progress: { phase: "identifying", bytes: 0 },
    });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      dispose();
    };
    const percent = () =>
      Math.min(
        state().completedFiles === state().totalFiles
          ? 100
          : 99,
        Math.floor(
          (state().processedWork /
            Math.max(1, state().totalWork)) *
            100,
        ),
      );
    toast.message(
      () => (
        <section
          aria-label={t("file_import_progress.title")}
          class="min-w-0 space-y-1.5 text-xs font-normal"
        >
          <div class="flex items-center justify-between gap-2">
            <span role="status" class="font-medium">
              {t(
                `file_import_progress.${state().ready ? state().progress.phase : "preparing"}`,
              )}
            </span>
            <Show when={state().ready}>
              <span class="text-muted-foreground ml-auto tabular-nums">
                {percent()}%
              </span>
            </Show>
            <Button
              size="icon"
              variant="ghost"
              class="size-6"
              aria-label={t("common.action.cancel")}
              title={t("common.action.cancel")}
              onClick={() => controller.abort()}
            >
              <X class="size-3.5" />
            </Button>
          </div>
          <Show when={state().fileName}>
            <p class="truncate" title={state().fileName}>
              {state().fileName}
            </p>
          </Show>
          <Progress
            value={state().ready ? percent() : 100}
            indeterminate={!state().ready}
            classList={{ "animate-pulse": !state().ready }}
            aria-label={t("file_import_progress.title")}
          />
          <Show when={state().ready}>
            <div
              class="text-muted-foreground flex justify-between gap-2
                tabular-nums"
            >
              <span>
                {t("file_import_progress.counts", {
                  completed: state().completedFiles,
                  total: state().totalFiles,
                })}
              </span>
              <span class="shrink-0">
                {formatBtyeSize(state().progress.bytes)} /{" "}
                {formatBtyeSize(state().fileSize)}
              </span>
            </div>
          </Show>
        </section>
      ),
      {
        id,
        duration: Infinity,
        dismissible: false,
        closeButton: false,
        onDismiss: cleanup,
        onAutoClose: cleanup,
      },
    );
    return {
      setFiles(files: readonly File[]) {
        if (closed) return;
        setState((value) => ({
          ...value,
          ready: true,
          totalFiles: files.length,
          // Reserve one pass each for reading, writing and checking content.
          // Reused content and stores without a verification pass skip that work on completion.
          totalWork: files.reduce(
            (total, file) =>
              total + Math.max(1, file.size) * 3,
            0,
          ),
        }));
      },
      startFile(file: File) {
        if (closed) return;
        setState((value) => ({
          ...value,
          fileName: file.name,
          fileSize: file.size,
          progress: { phase: "identifying", bytes: 0 },
        }));
      },
      update(progress: FileImportProgress) {
        if (closed || controller.signal.aborted) return;
        setState((value) => {
          const bytes = Math.max(
            0,
            Math.min(value.fileSize, progress.bytes),
          );
          const pass = {
            identifying: 0,
            writing: 1,
            verifying: 2,
          }[progress.phase];
          return {
            ...value,
            progress: { ...progress, bytes },
            processedWork: Math.max(
              value.processedWork,
              value.completedWork +
                Math.max(1, value.fileSize) * pass +
                bytes,
            ),
          };
        });
      },
      completeFile() {
        if (closed || controller.signal.aborted) return;
        setState((value) => {
          const completedWork =
            value.completedWork +
            Math.max(1, value.fileSize) * 3;
          return {
            ...value,
            completedFiles: value.completedFiles + 1,
            completedWork,
            processedWork: completedWork,
          };
        });
      },
      dismiss() {
        if (closed) return;
        toast.dismiss(id);
        cleanup();
      },
    };
  });
}
