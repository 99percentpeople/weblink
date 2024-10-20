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
import { Button } from "./ui/button";

export type PreviewDialogProps = {
  src: File | Blob;
};

const PreviewContent = (props: { src: File | null }) => {
  const dataUrl = createMemo(() => {
    const file = props.src;
    if (!file) return null;
    return URL.createObjectURL(file);
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
            src={dataUrl()!}
            class="h-full w-full object-contain"
          />
        </Match>
        <Match when={props.src?.type.startsWith("video/")}>
          <video
            controls
            src={dataUrl()!}
            class="h-full w-full object-contain"
          />
        </Match>
        <Match when={props.src?.type.startsWith("audio/")}>
          <audio controls src={dataUrl()!} />
        </Match>
        <Match
          when={props.src?.type.startsWith(
            "application/pdf",
          )}
        >
          <iframe src={dataUrl()!} class="h-full w-full" />
        </Match>
      </Switch>
    </div>
  );
};

export const createPreviewDialog = () => {
  const [src, setSrc] = createSignal<File | null>(null);

  const { open, Component } = createDialog({
    title: () => t("common.preview_dialog.title"),
    description: () => src()?.name ?? "",
    content: () => <PreviewContent src={src()} />,
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

export const createSendItemPreviewDialog = () => {
  const [src, setSrc] = createSignal<File | null>(null);

  const [name, setName] = createSignal("");

  const { open, close, submit, Component } = createDialog({
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
    Component,
  };
};
