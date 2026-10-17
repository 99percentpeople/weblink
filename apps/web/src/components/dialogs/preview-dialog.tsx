import type { StoredFile } from "@weblink/platform";
import { createFileUrl } from "@/libs/hooks/create-file-url";
import { LoaderCircle } from "lucide-solid";
import { createDialog } from "@/components/dialogs/dialog";
import { t } from "@/i18n";
import {
  createMemo,
  createSignal,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { downloadFile } from "@/libs/utils/download-file";
import {
  IconDownload,
  IconShare,
} from "@/components/icons";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { catchError } from "@/libs/catch";
import { canShareFile } from "@/libs/utils/can-share";
import { platform } from "@/libs/platform/runtime";
import { openFileExternally } from "@/libs/utils/open-file";

export type PreviewDialogProps = {
  src: File | Blob;
};

const PreviewContent = (props: {
  src: StoredFile | null;
}) => {
  const preview = createFileUrl(() => {
    const file = props.src;
    return file &&
      /^(image\/|video\/|audio\/|application\/pdf)/.test(
        file.type,
      )
      ? file
      : undefined;
  });

  return (
    <div class="flex aspect-video h-full w-full items-center justify-center">
      <Switch
        fallback={
          <>
            {t(
              "common.preview_dialog.unsupported_file_type",
            )}
          </>
        }
      >
        <Match when={preview.error()}>
          {(error) => (
            <div
              role="alert"
              class="text-muted-foreground space-y-2 text-sm"
            >
              <p>{t("errors.file_unavailable")}</p>
              <p>{error().message}</p>
            </div>
          )}
        </Match>
        <Match when={preview.loading()}>
          <LoaderCircle
            class="size-6 animate-spin"
            role="status"
            aria-label={t("common.preview_dialog.loading")}
          />
        </Match>
        <Match when={props.src?.type.startsWith("text/")}>
          {(_) => {
            const [text, setText] = createSignal("");
            onMount(async () => {
              const file = props.src;
              if (!file) return;
              setText(await file.text());
            });
            return (
              <Textarea
                class="h-full w-full resize-none"
                readOnly
                value={text()}
              />
            );
          }}
        </Match>
        <Match when={props.src?.type.startsWith("image/")}>
          <img
            src={preview.url()}
            class="h-full w-full object-contain"
          />
        </Match>
        <Match when={props.src?.type.startsWith("video/")}>
          <video
            controls
            src={preview.url()}
            class="h-full w-full object-contain"
          />
        </Match>
        <Match when={props.src?.type.startsWith("audio/")}>
          <audio controls src={preview.url()} />
        </Match>
        <Match
          when={props.src?.type.startsWith(
            "application/pdf",
          )}
        >
          <iframe
            src={preview.url()}
            class="h-full w-full"
          />
        </Match>
      </Switch>
    </div>
  );
};

export const createPreviewDialog = () => {
  if (platform.openFile)
    return { open: openFileExternally };
  const [src, setSrc] = createSignal<StoredFile | null>(
    null,
  );
  const shareableData = createMemo(() => {
    const f = src();
    if (!f) return null;
    if (!canShareFile(f)) return null;
    const shareData: ShareData = {
      files: [f],
    };
    return shareData;
  });
  const { open, close } = createDialog({
    title: () => t("common.preview_dialog.title"),
    description: () => (
      <p class="flex items-center justify-between gap-2">
        <span>{src()?.name}</span>
        <span>{formatBtyeSize(src()?.size ?? 0)}</span>
      </p>
    ),
    content: () => <PreviewContent src={src()} />,
    confirm: (
      <Show when={src()}>
        {(f) => (
          <Button
            onClick={() => {
              close();
              downloadFile(f());
            }}
          >
            <IconDownload class="mr-1 size-4" />
            {t("common.action.download")}
          </Button>
        )}
      </Show>
    ),
    cancel: (
      <Show when={shareableData()}>
        {(shareData) => (
          <Button
            variant="outline"
            onClick={async () => {
              close();
              const [err] = await catchError(
                navigator.share(shareData()),
              );
              if (err) console.error(err);
            }}
          >
            <IconShare class="mr-1 size-4" />
            {t("common.action.share")}
          </Button>
        )}
      </Show>
    ),
  });

  const handleOpen = async (src: StoredFile) => {
    setSrc(src);
    return await open();
  };

  return {
    open: handleOpen,
  };
};

export const createSendItemPreviewDialog = () => {
  const [src, setSrc] = createSignal<StoredFile | null>(
    null,
  );

  const [name, setName] = createSignal("");

  const { open, close, submit } = createDialog({
    title: () => t("common.send_item_preview_dialog.title"),
    description: () =>
      t("common.send_item_preview_dialog.description", {
        fileName: src()?.name ?? "",
        name: name(),
      }),
    content: () => <PreviewContent src={src()} />,
    cancel: (
      <Button variant="destructive" onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button onClick={() => submit(true)}>
        {t("common.action.send")}
      </Button>
    ),
  });

  const handleOpen = (src: File, name: string) => {
    setSrc(src);
    setName(name);
    return open();
  };

  return {
    open: handleOpen,
  };
};
