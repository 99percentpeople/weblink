import type { StoredFile } from "@weblink/platform";
import { appState } from "@/libs/state/app-state";
import type { AppNotifications } from "@/libs/state/notifications-context";
import { platform } from "@/libs/platform/runtime";
import { userErrorMessage } from "@/libs/user-error";
import { saveFilesAs } from "@/libs/utils/download-file";
import { createFileSaveConflictResolver } from "./file-save-conflict-toast";
import { showFileSaveProgress } from "./file-save-progress";

/** The operation owns its controller and notices, independently of the file manager. */
export async function saveFilesWithFeedback(
  files: readonly StoredFile[],
  notifications?: AppNotifications,
): Promise<void> {
  const snapshot = [...files];
  const controller = new AbortController();
  const notice = showFileSaveProgress(snapshot, controller);
  const conflicts = createFileSaveConflictResolver({
    controller,
    notifications,
    preview: () => appState.options.notifications.preview,
    showApplication: async () => {
      await platform.application?.show();
    },
    onWaiting: notice.setWaiting,
  });
  try {
    // Keep the picker in the initiating click's synchronous call chain.
    const completed = await saveFilesAs(
      snapshot,
      conflicts.resolve,
      {
        signal: controller.signal,
        onProgress: notice.update,
      },
    );
    notice.finish(completed);
  } catch (error) {
    notice.fail(
      userErrorMessage(error, "errors.file_failed"),
    );
  } finally {
    conflicts.dismiss();
  }
}
