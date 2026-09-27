import { children, Show, type JSX } from "solid-js";
import { Download, Eye } from "lucide-solid";
import { IconFile } from "@/components/icon-file";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { downloadFile } from "@/libs/utils/download-file";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";
import type { MediaHashRoute } from "./media-hash-route";
import { LocalFileMedia } from "./local-file-media";

/** Shared presentation only: the caller decides whether bytes are available. */
export function FileAttachmentBubble(props: {
  file?: File;
  route: MediaHashRoute;
  name: string;
  size: number;
  mimeType?: string;
  action?: JSX.Element;
  details?: JSX.Element;
  children?: JSX.Element;
}) {
  const { open: preview } = createPreviewDialog();
  const details = children(() => props.details);
  const media = () =>
    /^(image|video|audio)\//.test(
      props.file?.type || props.mimeType || "",
    );
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
      <div class="flex min-w-0 items-center gap-2">
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
            class="truncate text-sm font-medium"
            title={props.name}
          >
            {props.name}
          </p>
          <div class="text-muted-foreground mt-0.5 text-xs tabular-nums">
            {details() ?? formatBtyeSize(props.size)}
          </div>
        </div>
        <Show when={props.file}>
          {(file) => (
            <div class="flex shrink-0 items-center gap-0.5">
              <Show when={!media()}>
                <button
                  type="button"
                  class="hover:bg-foreground/10 focus-visible:ring-ring flex size-8
                    items-center justify-center rounded-full outline-none
                    focus-visible:ring-2"
                  aria-label={t("common.action.preview")}
                  title={t("common.action.preview")}
                  onClick={() => void preview(file())}
                >
                  <Eye class="size-4" />
                  <span class="sr-only">
                    {t("common.action.preview")}
                  </span>
                </button>
              </Show>
              <button
                type="button"
                class="hover:bg-foreground/10 focus-visible:ring-ring flex size-8
                  items-center justify-center rounded-full outline-none
                  focus-visible:ring-2"
                aria-label={t("common.action.download")}
                title={t("common.action.download")}
                onClick={() => downloadFile(file())}
              >
                <Download class="size-4" />
                <span class="sr-only">
                  {t("common.action.download")}
                </span>
              </button>
            </div>
          )}
        </Show>
        {props.action}
      </div>
      {props.children}
    </div>
  );
}
