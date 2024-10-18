import { createDialog } from "@/components/dialogs/dialog";
import { t } from "@/i18n";
import {
  createMemo,
  createSignal,
  Match,
  onMount,
  Switch,
} from "solid-js";
import { Textarea } from "./ui/textarea";

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
          <Match when={src()?.type.startsWith("text/")}>
            {(_) => {
              const [text, setText] = createSignal("");
              onMount(async () => {
                const file = src();
                if (!file) return;
                setText(text);
              });
              return <Textarea readOnly value={text()} />;
            }}
          </Match>
          <Match when={src()?.type.startsWith("image/")}>
            <img
              src={dataUrl()!}
              class="h-full w-full object-contain"
            />
          </Match>
          <Match when={src()?.type.startsWith("video/")}>
            <video
              controls
              src={dataUrl()!}
              class="h-full w-full object-contain"
            />
          </Match>
          <Match when={src()?.type.startsWith("audio/")}>
            <audio controls src={dataUrl()!} />
          </Match>
          <Match
            when={src()?.type.startsWith("application/pdf")}
          >
            <iframe
              src={dataUrl()!}
              class="h-full w-full"
            />
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
