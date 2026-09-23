import { useAppState } from "@/libs/state/app-state-context";
import {
  createSignal,
  Show,
  splitProps,
  type Component,
  type ComponentProps,
} from "solid-js";
import type { Client } from "@/libs/domain/client";
import { createSendItemPreviewDialog } from "@/components/dialogs/preview-dialog";
import { appState } from "@/libs/state/app-state";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { ChatComposer } from "@/components/conversations/chat-composer";

export const ChatBar: Component<
  ComponentProps<"div"> & { client: Client }
> = (props) => {
  const [local, other] = splitProps(props, [
    "client",
    "class",
  ]);
  const { sendText, sendFile } = useAppState();
  const [text, setText] = createSignal("");
  const { open: openPreview } =
    createSendItemPreviewDialog();
  const mobile = createIsMobile();
  return (
    <ChatComposer
      {...other}
      class={local.class}
      value={text()}
      onValueChange={setText}
      onSendText={(value) =>
        sendText(value, local.client.clientId)
      }
      onSendFiles={async (files) => {
        const clientId = local.client.clientId;
        for (const file of files)
          await sendFile(file, clientId);
      }}
      previewFile={async (file) =>
        Boolean(
          (await openPreview(file, local.client.name))
            .result,
        )
      }
      onPaste={(event) => {
        if (
          !navigator.clipboard ||
          !appState.options.enableClipboard
        )
          return;
        if (!mobile()) event.stopPropagation();
        else if (
          !Array.from(
            event.clipboardData?.items ?? [],
          ).some((item) => item.kind === "file")
        ) {
          setTimeout(() => setText(""), 0);
        }
      }}
    />
  );
};
