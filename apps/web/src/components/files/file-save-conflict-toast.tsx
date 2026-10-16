import {
  createRoot,
  createSignal,
  createUniqueId,
} from "solid-js";
import { toast } from "solid-sonner";
import type {
  FileConflictAction,
  FileConflictResolver,
} from "@weblink/platform";
import { Button } from "@/components/ui/button";
import {
  Checkbox,
  CheckboxControl,
  CheckboxLabel,
} from "@/components/ui/checkbox";
import type { AppNotifications } from "@/libs/state/notifications-context";
import { t } from "@/i18n";

/** Choices are remembered only for this batch; every prompt owns its notification. */
export function createFileSaveConflictResolver(options: {
  controller: AbortController;
  notifications?: AppNotifications;
  preview(): boolean;
  showApplication(): Promise<void>;
  onWaiting(waiting: boolean): void;
}): { resolve: FileConflictResolver; dismiss(): void } {
  const signal = options.controller.signal;
  let remembered: FileConflictAction | undefined;
  let disposed = false;
  let cancelPending: (() => void) | undefined;
  return {
    dismiss() {
      disposed = true;
      cancelPending?.();
    },
    async resolve(conflict) {
      if (disposed || signal.aborted) return null;
      if (
        remembered &&
        (remembered !== "overwrite" ||
          conflict.canOverwrite)
      )
        return remembered;
      options.onWaiting(true);
      try {
        return await createRoot(
          (dispose) =>
            new Promise<FileConflictAction | null>(
              (resolve) => {
                const id = `file-save-conflict:${createUniqueId()}`;
                const [applyToAll, setApplyToAll] =
                  createSignal(false);
                let settled = false;
                const current = () =>
                  !settled && !disposed && !signal.aborted;
                const settle = (
                  action: FileConflictAction | null,
                ) => {
                  if (settled) return;
                  if (
                    action === "overwrite" &&
                    !conflict.canOverwrite
                  )
                    return;
                  if (!current()) action = null;
                  if (action && applyToAll())
                    remembered = action;
                  settled = true;
                  signal.removeEventListener(
                    "abort",
                    cancel,
                  );
                  cancelPending = undefined;
                  options.notifications?.dismiss(id);
                  toast.dismiss(id);
                  dispose();
                  resolve(action);
                };
                const cancel = () => settle(null);
                cancelPending = cancel;
                signal.addEventListener("abort", cancel, {
                  once: true,
                });
                const description = () =>
                  t(
                    conflict.canOverwrite
                      ? "file_save_conflict.description"
                      : "file_save_conflict.cannot_overwrite",
                    { fileName: conflict.fileName },
                  );
                // Keep the interactive confirmation available in the app. The existing
                // background channel only reminds the user and opens this same prompt.
                toast.message(
                  () => (
                    <section
                      id={id}
                      tabIndex={-1}
                      aria-label={t(
                        "file_save_conflict.title",
                      )}
                      class="min-w-0 space-y-2 text-xs font-normal"
                    >
                      <p class="font-medium">
                        {t("file_save_conflict.title")}
                      </p>
                      <p class="text-muted-foreground break-words">
                        {description()}
                      </p>
                      <Checkbox
                        class="flex items-center gap-2"
                        checked={applyToAll()}
                        onChange={setApplyToAll}
                      >
                        <CheckboxControl />
                        <CheckboxLabel>
                          {t(
                            "file_save_conflict.apply_to_all",
                          )}
                        </CheckboxLabel>
                      </Checkbox>
                      <div class="flex flex-wrap justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (current())
                              options.controller.abort();
                          }}
                        >
                          {t("common.action.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => settle("skip")}
                        >
                          {t("file_save_conflict.skip")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            settle("keep_both")
                          }
                        >
                          {t(
                            "file_save_conflict.keep_both",
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!conflict.canOverwrite}
                          onClick={() =>
                            settle("overwrite")
                          }
                        >
                          {t(
                            "file_save_conflict.overwrite",
                          )}
                        </Button>
                      </div>
                    </section>
                  ),
                  {
                    id,
                    duration: Infinity,
                    dismissible: false,
                    closeButton: false,
                  },
                );
                void options.notifications
                  ?.show({
                    category: "transfers",
                    current,
                    notification: {
                      id,
                      title: t("file_save_conflict.title"),
                      body: options.preview()
                        ? description()
                        : t("file_save_conflict.title"),
                      expiresAt: Date.now() + 10 * 60_000,
                    },
                    async respond() {
                      if (!current()) return;
                      await options.showApplication();
                      if (current())
                        document
                          .getElementById(id)
                          ?.focus();
                    },
                  })
                  .catch((error) =>
                    console.warn(
                      "File save notification failed",
                      error,
                    ),
                  );
              },
            ),
        );
      } finally {
        options.onWaiting(false);
      }
    },
  };
}
