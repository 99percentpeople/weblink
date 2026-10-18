import { onCleanup } from "solid-js";
import { toast } from "solid-sonner";
import type { StoredFile } from "@weblink/platform";
import { t } from "@/i18n";
import type { RecordingControls } from "@/libs/state/create-recording";
import type { AppNotifications } from "@/libs/state/notifications-context";

/** Recording completion uses the same foreground/background delivery owner as other notices. */
export function createRecordingFeedback(options: {
  recording: Pick<RecordingControls, "onSaved">;
  notifications: AppNotifications;
  preview(): boolean;
  openLabel(): string;
  readFile(id: string): Promise<StoredFile | null>;
  openFile(file: StoredFile): Promise<unknown>;
  showApplication(): Promise<void>;
}) {
  let disposed = false;
  const notices = new Set<string>();
  const unsubscribe = options.recording.onSaved((saved) => {
    if (disposed) return;
    const id = `recording-saved:${saved.id}`;
    notices.add(id);
    const title = t("recording.saved");
    const preview = options.preview();
    let opened = false;
    const current = () => !disposed && !opened;
    const open = async () => {
      if (!current()) return;
      opened = true;
      options.notifications.dismiss(id);
      try {
        await options.showApplication();
        if (disposed) return;
        const file = await options.readFile(saved.id);
        if (disposed) return;
        if (!file)
          throw new Error("Saved recording is unavailable");
        await options.openFile(file);
      } catch (error) {
        if (disposed) return;
        console.warn(
          "Could not open saved recording",
          error,
        );
        toast.error(
          t("common.notification.file_open_failed"),
        );
      }
    };
    void options.notifications.show({
      category: "recordings",
      current,
      retainInApp: true,
      canDisplay: () => options.preview() === preview,
      present() {
        toast.success(title, {
          id,
          description: options.preview()
            ? saved.fileName
            : undefined,
          duration: 10_000,
          action: {
            label: options.openLabel(),
            onClick: () => void open(),
          },
        });
        return { dismiss: () => toast.dismiss(id) };
      },
      notification: {
        id,
        title,
        body: preview ? saved.fileName : title,
        expiresAt: Date.now() + 10 * 60_000,
        actions: [
          { id: "open", title: options.openLabel() },
        ],
      },
      async respond(action) {
        if (action.action === "open") await open();
      },
    });
  });
  onCleanup(() => {
    disposed = true;
    unsubscribe();
    for (const id of notices)
      options.notifications.dismiss(id);
    notices.clear();
  });
}
