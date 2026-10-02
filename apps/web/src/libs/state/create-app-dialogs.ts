import {
  createComponent,
  createSignal,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { createDialog } from "@/components/dialogs/dialog";
import { Spinner } from "@/components/common/spinner";
import { createTaskCenterDialog } from "@/components/app/task-center";
import type { SettingsSection } from "@/components/settings/settings-content";
import { t } from "@/i18n";
import { preload } from "@/libs/utils/preload";

const SettingsContent = preload(
  () => import("@/components/settings/settings-content"),
);
const FileManager = preload(
  () => import("@/components/files/file-manager"),
);

export function createAppDialogs() {
  const preloadSettings = () => {
    void SettingsContent.preload().catch(() => undefined);
  };
  onMount(() => {
    // SettingsContent imports every section; warm the whole dialog without
    // mounting sections or starting their permission/capability queries.
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(
        preloadSettings,
        {
          timeout: 2000,
        },
      );
      onCleanup(() => window.cancelIdleCallback(idle));
    } else {
      const timer = window.setTimeout(preloadSettings, 500);
      onCleanup(() => window.clearTimeout(timer));
    }
  });
  const [section, setSection] =
    createSignal<SettingsSection>("appearance");
  const [settingsOpen, setSettingsOpen] =
    createSignal(false);
  const [filesOpen, setFilesOpen] = createSignal(false);
  const tasks = createTaskCenterDialog();
  const settings = createDialog({
    class: "app-settings-dialog",
    title: () => t("common.nav.settings"),
    content: () =>
      createComponent(Show, {
        keyed: true,
        get when() {
          return settingsOpen();
        },
        get children() {
          return createComponent(Suspense, {
            get fallback() {
              return createComponent(Spinner, {});
            },
            get children() {
              return createComponent(SettingsContent, {
                get section() {
                  return section();
                },
                onSectionChange: setSection,
                onClose: () => settings.close(),
              });
            },
          });
        },
      }),
  });
  const files = createDialog({
    class: "app-files-dialog",
    title: () => t("cache.title"),
    content: () =>
      createComponent(Show, {
        keyed: true,
        get when() {
          return filesOpen();
        },
        get children() {
          return createComponent(Suspense, {
            get fallback() {
              return createComponent(Spinner, {});
            },
            get children() {
              return createComponent(FileManager, {});
            },
          });
        },
      }),
  });
  return {
    // Warmups are best effort; opening still uses Suspense.
    preloadSettings,
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
