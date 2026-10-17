import { createSignal, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import { createCacheManager } from "@/libs/application/cache-service";
import type { FileStorageService } from "@/libs/application/file-storage-service";
import type { StorageMigrationProgress } from "@/libs/domain/storage-migration";
import { formatBtyeSize } from "@/libs/utils/format-filesize";

/** App lifetime, independent of file dialogs; subscription replays startup progress. */
export function StorageMigrationToast(props: {
  storage?: FileStorageService;
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
        <section
          aria-label={t("storage_migration.title")}
          class="min-w-0 space-y-1.5 text-xs font-normal"
        >
          <div class="flex items-center justify-between gap-2">
            <span role="status" class="font-medium">
              {t(`storage_migration.${progress()!.phase}`)}
            </span>
            <Show when={!finished()}>
              <span class="text-muted-foreground tabular-nums">
                {percent()}%
              </span>
            </Show>
          </div>
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
              aria-label={t("storage_migration.title")}
            />
          </Show>
          <div
            class="text-muted-foreground flex justify-between gap-2
              tabular-nums"
          >
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
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                {progress()!
                  .failures.map(
                    (failure) =>
                      `${failure.fileName}\n${failure.error}`,
                  )
                  .join("\n\n")}
              </pre>
            </details>
          </Show>
        </section>
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
