import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { VfsVolumeInfo } from "@weblink/platform";
import { ChevronDown, FolderOpen } from "lucide-solid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FileStorageService } from "@/libs/application/file-storage-service";
import { platform } from "@/libs/platform/runtime";
import { userErrorMessage } from "@/libs/user-error";
import { t } from "@/i18n";
import { toast } from "solid-sonner";

/** Mounted native roots open in the system file manager. */
export function MountedDirectoryMenu(props: {
  storage: FileStorageService;
}) {
  const [mounts, setMounts] = createSignal<VfsVolumeInfo[]>(
    [],
  );
  onMount(() => {
    const refresh = () =>
      setMounts(
        props.storage
          .mounts()
          .filter((mount) => mount.kind === "native"),
      );
    refresh();
    onCleanup(props.storage.onChange(refresh));
  });
  const open = (id: string) => {
    void platform.filesystem
      ?.openDirectory(id)
      .catch((error) =>
        toast.error(
          userErrorMessage(error, "errors.file_failed"),
        ),
      );
  };
  return (
    <Show when={platform.filesystem && mounts().length}>
      <Show
        when={mounts().length === 1}
        fallback={
          <DropdownMenu>
            <DropdownMenuTrigger
              as={Button}
              variant="outline"
              size="sm"
            >
              <FolderOpen class="mr-2 size-4" />
              {t("storage.open_directory")}
              <ChevronDown class="ml-2 size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <For each={mounts()}>
                {(mount) => (
                  <DropdownMenuItem
                    onSelect={() => open(mount.id)}
                  >
                    {mount.name}
                  </DropdownMenuItem>
                )}
              </For>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => open(mounts()[0].id)}
        >
          <FolderOpen class="mr-2 size-4" />
          {t("storage.open_directory")}
        </Button>
      </Show>
    </Show>
  );
}
