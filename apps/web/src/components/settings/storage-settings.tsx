import {
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { createCacheManager } from "@/libs/application/cache-service";
import { useAppDialogs } from "@/libs/state/app-dialogs-context";
import { platform } from "@/libs/platform/runtime";
import { userErrorMessage } from "@/libs/user-error";
import { SettingSelect } from "./setting-controls";
import {
  SettingBlock,
  SettingHeading,
  SettingRow,
} from "./setting-layout";
import { t } from "@/i18n";

type StorageMode = "indexeddb" | "directory";

export default function StorageSettings() {
  const storage = createCacheManager().storage;
  const dialogs = useAppDialogs();
  const [revision, setRevision] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      if (
        !(
          error instanceof DOMException &&
          error.name === "AbortError"
        )
      )
        setError(userErrorMessage(error));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };
  onMount(() => {
    onCleanup(
      storage.onChange(() =>
        setRevision((value) => value + 1),
      ),
    );
    void run(() => storage.initialize());
  });
  const mounts = createMemo(() => {
    revision();
    return storage.mounts();
  });
  const selected = createMemo(() => {
    revision();
    return storage.defaultMountId;
  });
  const mode = (): StorageMode =>
    selected() === "indexeddb" ? "indexeddb" : "directory";
  const canOpenDirectory = () =>
    mounts().find((mount) => mount.id === selected())
      ?.canOpen;
  const directories = createMemo(() =>
    mounts().filter((mount) => mount.kind !== "indexeddb"),
  );
  const lastDirectory = createMemo<string | undefined>(
    (previous) =>
      mode() === "directory" ? selected() : previous,
  );
  const modeLabel = (value: StorageMode) =>
    value === "indexeddb"
      ? t("storage.browser")
      : t("storage.local_directory");
  const directoryLabel = (id: string) =>
    directories().find((mount) => mount.id === id)?.name ??
    t("storage.unavailable");
  const chooseDirectory = () =>
    run(async () => {
      const id = await storage.mountDirectory();
      if (id) await storage.setDefault(id);
    });
  const [needsReconnect] = createResource(
    () =>
      platform.kind === "browser" && mode() === "directory"
        ? { id: selected(), revision: revision() }
        : undefined,
    async ({ id }) => {
      try {
        const directory = await storage.getVolume(id);
        return (
          (await directory.stat(""))?.kind !== "directory"
        );
      } catch {
        return true;
      }
    },
  );
  return (
    <>
      <SettingHeading id="file-storage">
        {t("storage.title")}
      </SettingHeading>
      <SettingSelect<StorageMode>
        label={t("storage.default")}
        description={t("storage.description")}
        disabled={busy()}
        value={mode()}
        options={["indexeddb", "directory"]}
        optionDisabled={(value) =>
          value === "directory" &&
          !storage.canMountDirectory &&
          directories().length === 0
        }
        disallowEmptySelection
        onChange={(value) => {
          if (!value || value === mode()) return;
          if (value === "indexeddb") {
            void run(() => storage.setDefault("indexeddb"));
            return;
          }
          const directory =
            directories().find(
              (mount) => mount.id === lastDirectory(),
            ) ?? directories()[0];
          if (directory)
            void run(() =>
              storage.setDefault(directory.id),
            );
          else if (storage.canMountDirectory)
            void chooseDirectory();
        }}
        optionLabel={modeLabel}
      />
      <Show when={mode() === "directory"}>
        <SettingRow
          label={t("storage.directory")}
          description={directoryLabel(selected())}
          disabled={busy()}
        >
          <div class="flex flex-wrap gap-2">
            <Show when={storage.canMountDirectory}>
              <Button
                variant="outline"
                disabled={busy()}
                onClick={() => void chooseDirectory()}
              >
                {t("storage.choose")}
              </Button>
            </Show>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() => {
                if (canOpenDirectory())
                  void run(() =>
                    storage.openDirectory(selected()),
                  );
                else void dialogs.openFiles();
              }}
            >
              {t(
                canOpenDirectory()
                  ? "storage.open_directory"
                  : "storage.open_cache",
              )}
            </Button>
            <Show
              when={
                platform.kind === "browser" &&
                !needsReconnect.loading &&
                needsReconnect()
              }
            >
              <Button
                variant="outline"
                disabled={busy()}
                onClick={() =>
                  void run(() =>
                    storage.authorize(selected()),
                  )
                }
              >
                {t("storage.reconnect")}
              </Button>
            </Show>
          </div>
        </SettingRow>
      </Show>
      <Show when={error()}>
        <SettingBlock>
          <p role="alert" class="text-destructive text-sm">
            {error()}
          </p>
        </SettingBlock>
      </Show>
    </>
  );
}
