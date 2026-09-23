import {
  createContext,
  createSignal,
  Show,
  Suspense,
  useContext,
  type ParentProps,
} from "solid-js";
import { createDialog } from "@/components/dialogs/dialog";
import { Spinner } from "@/components/common/spinner";
import { createTaskCenterDialog } from "./task-center";
import type { SettingsSection } from "@/components/settings/settings-content";
import { t } from "@/i18n";
import { preload } from "@/libs/utils/preload";

const SettingsContent = preload(
  () => import("@/components/settings/settings-content"),
);
const FileManager = preload(
  () => import("@/components/files/file-manager"),
);

function createAppDialogs() {
  const [section, setSection] =
    createSignal<SettingsSection>("appearance");
  const [settingsOpen, setSettingsOpen] =
    createSignal(false);
  const [filesOpen, setFilesOpen] = createSignal(false);
  const tasks = createTaskCenterDialog();
  const settings = createDialog({
    class: "app-settings-dialog",
    title: () => t("common.nav.settings"),
    content: () => (
      <Show when={settingsOpen()}>
        <Suspense fallback={<Spinner />}>
          <SettingsContent
            section={section()}
            onSectionChange={setSection}
            onClose={() => settings.close()}
          />
        </Suspense>
      </Show>
    ),
  });
  const files = createDialog({
    class: "app-files-dialog",
    title: () => t("cache.title"),
    content: () => (
      <Show when={filesOpen()}>
        <Suspense fallback={<Spinner />}>
          <FileManager />
        </Suspense>
      </Show>
    ),
  });
  return {
    // Intent-based warmups are best effort; opening still uses Suspense.
    preloadSettings: () => {
      void SettingsContent.preload().catch(() => undefined);
    },
    preloadFiles: () => {
      void FileManager.preload().catch(() => undefined);
    },
    openTasks: () => {
      void tasks.open();
    },
    openSettings: async (next?: SettingsSection) => {
      if (next) setSection(next);
      if (settingsOpen()) return;
      setSettingsOpen(true);
      try {
        await settings.open();
      } finally {
        setSettingsOpen(false);
      }
    },
    openFiles: async () => {
      if (filesOpen()) return;
      setFilesOpen(true);
      try {
        await files.open();
      } finally {
        setFilesOpen(false);
      }
    },
  };
}

const AppDialogsContext =
  createContext<ReturnType<typeof createAppDialogs>>();
export function AppDialogsProvider(props: ParentProps) {
  const dialogs = createAppDialogs();
  return (
    <AppDialogsContext.Provider value={dialogs}>
      {props.children}
    </AppDialogsContext.Provider>
  );
}
export function useAppDialogs() {
  const dialogs = useContext(AppDialogsContext);
  if (!dialogs)
    throw new Error("AppDialogsProvider is missing");
  return dialogs;
}
