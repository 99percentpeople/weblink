import { createSignal, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Progress } from "@/components/ui/progress";
import { ToastContent } from "@/components/ui/toast-content";
import { t } from "@/i18n";
import { createCacheManager } from "@/libs/application/cache-service";
import type { FileStorage } from "@/libs/domain/file-storage";
import type { StorageMigrationProgress } from "@/libs/domain/storage-migration";
import { formatBtyeSize } from "@/libs/utils/format-filesize";

/** App lifetime, independent of file dialogs; subscription replays startup progress. */
export function StorageMigrationToast(props: {
  storage?: FileStorage;
}) {
  const storage =
    props.storage ?? createCacheManager().storage;
  const [progress, setProgress] =
    createSignal<StorageMigrationProgress>();
  const id = "indexeddb-migration";
  let visible = false;
  const finished = () =>
    ["completed", "failed"].includes(
      progress()?.phase ?? "",
    );
  const percent = () => {
    const state = progress()!;
    const phase =
      state.phase === "copying"
        ? 0
        : state.phase === "verifying"
          ? 1
          : state.phase === "deleting"
            ? 2
            : 0;
    const current =
      state.phase === "deleting"
        ? 1
        : (phase +
            Math.min(
              1,
              state.bytes / Math.max(1, state.totalBytes),
            )) /
          2;
    return state.phase === "completed"
      ? 100
      : Math.min(
          99,
          Math.floor(
            (100 * (state.completedFiles + current)) /
              state.totalFiles,
          ),
        );
  };
  const stop = storage.onMigrationProgress((state) => {
    setProgress(state);
    if (visible && !finished()) return;
    visible = true;
    toast.message(
      () => (
        <ToastContent
          aria-label={t("storage_migration.title")}
          status
          title={t(
            `storage_migration.${progress()!.phase}`,
          )}
          trailing={
            <Show when={!finished()}>
              <span>{percent()}%</span>
            </Show>
          }
        >
          <Show when={!finished()}>
            <p
              class="truncate"
              title={progress()!.fileName}
            >
              {progress()!.fileName}
            </p>
            <Progress
              value={percent()}
              indeterminate={
                progress()!.phase === "waiting"
              }
              classList={{
                "animate-pulse":
                  progress()!.phase === "waiting",
              }}
              aria-label={t("storage_migration.title")}
            />
          </Show>
          <div class="toast-meta">
            <span>
              {t("storage_migration.counts", {
                completed: progress()!.completedFiles,
                total: progress()!.totalFiles,
              })}
            </span>
            <Show
              when={
                !finished() && progress()!.totalBytes > 0
              }
            >
              <span>
                {formatBtyeSize(progress()!.bytes)} /{" "}
                {formatBtyeSize(progress()!.totalBytes)}
              </span>
            </Show>
          </div>
          <Show when={progress()!.phase === "waiting"}>
            <p>{t("storage_migration.close_other_tabs")}</p>
          </Show>
          <Show when={progress()!.phase === "failed"}>
            <p>{t("storage_migration.retained")}</p>
            <details>
              <summary class="cursor-pointer">
                {t("storage_migration.error_details")}
              </summary>
              <pre class="toast-error-details">
                {progress()!
                  .failures.map(
                    (failure) =>
                      `${failure.fileName}\n${failure.error}`,
                  )
                  .join("\n\n")}
              </pre>
            </details>
          </Show>
        </ToastContent>
      ),
      {
        id,
        duration:
          state.phase === "completed" ? 5000 : Infinity,
        dismissible: finished(),
        closeButton: finished(),
      },
    );
  });
  onCleanup(() => {
    stop();
    if (visible) toast.dismiss(id);
  });
  return null;
}
