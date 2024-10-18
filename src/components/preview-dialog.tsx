import { createDialog } from "@/components/dialogs/dialog";
import { t } from "@/i18n";
import {
  createMemo,
  createSignal,
  Match,
  Switch,
} from "solid-js";

export type PreviewDialogProps = {
  src: File | Blob;
};

export const createPreviewDialog = () => {
  const [src, setSrc] = createSignal<File | null>(null);

  const dataUrl = createMemo(() => {
    const file = src();
    if (!file) return null;
    return URL.createObjectURL(file);
  });

  const { open, Component } = createDialog({
    title: () => t("common.preview_dialog.title"),
    description: () => src()?.name ?? "",
    content: () => (
      <div class="flex h-full w-full items-center justify-center aspect-video">
        <Switch
          fallback={
            <>
              {t(
                "common.preview_dialog.unsupported_file_type",
              )}
            </>
          }
        >
          <Match when={src()?.type.startsWith("image/")}>
            <img src={dataUrl()!} class="h-full w-full object-contain" />
          </Match>
          <Match when={src()?.type.startsWith("video/")}>
            <video controls src={dataUrl()!} class="h-full w-full object-contain" />
          </Match>
          <Match when={src()?.type.startsWith("audio/")}>
            <audio controls src={dataUrl()!} />
          </Match>
          <Match
            when={src()?.type.startsWith("application/pdf")}
          >
            <iframe src={dataUrl()!} class="w-full h-full" />
          </Match>
        </Switch>
      </div>
    ),
  });

  const handleOpen = (src: File) => {
    setSrc(src);
    open();
  };

  return {
    open: handleOpen,
    Component,
  };
};
