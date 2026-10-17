import type { StoredFile } from "@weblink/platform";
import type { FileCapabilities } from "@/libs/domain/file-storage";
import {
  children,
  createMemo,
  Show,
  type JSX,
} from "solid-js";
import { Download, Eye, ExternalLink } from "lucide-solid";
import { IconFile } from "@/components/icon-file";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { fileSaveAction } from "@/libs/utils/file-save-action";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import type { MediaHashRoute } from "./media-hash-route";
import { LocalFileMedia } from "./local-file-media";
import { platform } from "@/libs/platform/runtime";
import { fileOpenLabel } from "@/libs/utils/open-file";

/** Shared presentation only: the caller decides whether bytes are available. */
export function FileAttachmentBubble(props: {
  file?: StoredFile;
  capabilities?: FileCapabilities;
  route: MediaHashRoute;
  name: string;
  size: number;
  mimeType?: string;
  action?: JSX.Element;
  /** Total buttons available after message-level actions such as retry. */
  actionLimit?: number;
  /** Buttons supplied by the caller in action, before local open/save actions. */
  actionCount?: number;
  details?: JSX.Element;
  children?: JSX.Element;
}) {
  const { open: preview } = createPreviewDialog();
  const saveAction = createMemo(() =>
    fileSaveAction(props.capabilities),
  );
  const details = children(() => props.details);
  const media = () =>
    /^(image|video|audio)\//.test(
      props.file?.type || props.mimeType || "",
    );
  const localActionLimit = () =>
    Math.max(
      0,
      (props.actionLimit ?? 2) - (props.actionCount ?? 0),
    );
  const showOpen = () => !media() && localActionLimit() > 0;
  const showSave = () =>
    props.capabilities?.inlineSave !== false &&
    localActionLimit() > Number(!media());
  return (
    <div
      class="flex min-w-0 flex-col gap-2"
      data-slot="file-attachment-bubble"
    >
      <Show when={props.file}>
        {(file) => (
          <LocalFileMedia
            file={file()}
            route={props.route}
            mimeType={props.mimeType}
          />
        )}
      </Show>
      <div class="flex min-h-11 min-w-0 items-center gap-2">
        <Show when={!props.file || !media()}>
          <span
            class="bg-foreground/5 flex size-10 shrink-0 items-center
              justify-center rounded-lg"
          >
            <IconFile
              mimetype={props.mimeType}
              class="size-5"
            />
          </span>
        </Show>
        <div class="min-w-0 flex-1">
          <p
            class="truncate text-sm font-medium leading-5"
            title={props.name}
          >
            {props.name}
          </p>
          <div
            class="text-muted-foreground mt-0.5 min-h-4 truncate text-xs
              tabular-nums leading-4"
          >
            {details() ?? formatBtyeSize(props.size)}
          </div>
        </div>
        <Show when={props.file}>
          {(file) => (
            <Show when={showOpen() || showSave()}>
              <div class="flex shrink-0 items-center gap-0.5">
                <Show when={showOpen()}>
                  <button
                    type="button"
                    class="hover:bg-foreground/10 focus-visible:ring-ring flex size-8
                      items-center justify-center rounded-full outline-none
                      focus-visible:ring-2"
                    aria-label={fileOpenLabel()}
                    title={fileOpenLabel()}
                    onClick={() => void preview(file())}
                  >
                    <Show
                      when={platform.openFile}
                      fallback={<Eye class="size-4" />}
                    >
                      <ExternalLink class="size-4" />
                    </Show>
                    <span class="sr-only">
                      {fileOpenLabel()}
                    </span>
                  </button>
                </Show>
                <Show when={showSave()}>
                  <button
                    type="button"
                    class="hover:bg-foreground/10 focus-visible:ring-ring flex size-8
                      items-center justify-center rounded-full outline-none
                      focus-visible:ring-2"
                    aria-label={saveAction().label}
                    title={saveAction().label}
                    onClick={() =>
                      saveAction().save(file())
                    }
                  >
                    <Download class="size-4" />
                    <span class="sr-only">
                      {saveAction().label}
                    </span>
                  </button>
                </Show>
              </div>
            </Show>
          )}
        </Show>
        {props.action}
      </div>
      {props.children}
    </div>
  );
}
