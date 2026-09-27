import { createMemo, splitProps } from "solid-js";
import { createConversationDraft } from "@/libs/hooks/conversation-draft";
import {
  ChatComposer,
  type ChatComposerProps,
} from "./chat-composer";
import { createSendItemPreviewDialog } from "@/components/dialogs/preview-dialog";
import { useAppState } from "@/libs/state/app-state-context";
import { CHAT_MAX_TEXT_LENGTH } from "@/libs/domain/protocol/chat-text";

type Props = Omit<
  ChatComposerProps,
  | "value"
  | "onValueChange"
  | "onSendText"
  | "onSendFiles"
  | "conversationKey"
  | "previewFile"
> & {
  conversationId: string;
  title: string;
};

/** One draft, input policy and submission boundary for both conversation kinds. */
export function ConversationComposer(props: Props) {
  const [local, rest] = splitProps(props, [
    "conversationId",
    "title",
  ]);
  const state = useAppState();
  const drafts = createMemo(() =>
    createConversationDraft(local.conversationId),
  );
  const { open: openPreview } =
    createSendItemPreviewDialog();
  return (
    <ChatComposer
      {...rest}
      conversationKey={local.conversationId}
      value={drafts().value()}
      onValueChange={(value) => drafts().update(value)}
      maxLength={CHAT_MAX_TEXT_LENGTH}
      onSendText={async (text) => {
        const draft = drafts();
        const snapshot = draft.value();
        await state.conversationMessaging.sendText(
          local.conversationId,
          text,
        );
        // Acceptance can finish after navigating away; retire only this saved draft.
        draft.accepted(snapshot);
      }}
      onSendFiles={async (files) => {
        const conversation = local.conversationId;
        for (const file of files) {
          if (conversation !== local.conversationId) break;
          await state.conversationMessaging.sendFile(
            conversation,
            file,
          );
        }
      }}
      previewFile={async (file) =>
        Boolean(
          (await openPreview(file, local.title)).result,
        )
      }
      onPaste={(event) => event.stopPropagation()}
    />
  );
}
