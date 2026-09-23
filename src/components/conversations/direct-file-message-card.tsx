import { createMemo, createSignal, Show } from "solid-js";
import { toast } from "solid-sonner";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import type { FileTransferMessage } from "@/libs/domain/message";
import { findMessageTransfer } from "@/libs/application/transfer/file-transfer-state";
import { directConversationId } from "@/libs/domain/conversation";
import { t } from "@/i18n";
import { FileAttachmentBubble } from "./file-attachment-bubble";
import {
  FileTransferDetails,
  FileTransferIndicator,
  type TransferAction,
} from "./file-transfer-indicator";

export function DirectFileMessageCard(props: {
  message: FileTransferMessage;
}) {
  const state = useAppState();
  const [pending, setPending] = createSignal(false);
  const live = createMemo(
    () =>
      !!findMessageTransfer(
        appState.transfer.transfers,
        props.message,
      ),
  );
  const sender = () =>
    props.message.client === appState.profile.clientId;
  const peerId = () =>
    sender() ? props.message.target : props.message.client;
  const cache = () =>
    props.message.fid
      ? appState.cache.cacheInfo[props.message.fid]
      : undefined;
  const merging = () => !sender() && !!cache()?.isMerging;
  const complete = () =>
    props.message.transferStatus === "complete";
  const canResume = () =>
    !!cache() &&
    !!appState.session.clientViewData[peerId()]
      ?.messageChannel &&
    props.message.status === "received" &&
    !!props.message.transferStatus &&
    !complete() &&
    !live() &&
    (sender() || (!cache()?.isComplete && !merging()));
  const control = (): TransferAction | undefined =>
    live() ? "pause" : canResume() ? "resume" : undefined;
  const showTransfer = () =>
    live() ||
    merging() ||
    (!!props.message.transferStatus && !complete());
  const status = () =>
    merging()
      ? t("common.file_table.status.merging")
      : t(
          `tasks.status.${complete() ? "completed" : live() ? (props.message.progress ? "running" : "waiting") : props.message.transferStatus === "error" ? "failed" : "paused"}`,
        );
  const act = async () => {
    if (pending()) return;
    const info = cache();
    if (!info) return;
    setPending(true);
    try {
      if (live()) await state.pauseFile(info.id, peerId());
      else if (canResume()) {
        if (sender())
          await state.resumeFile(info.id, peerId());
        else await state.requestFile(peerId(), info, true);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <FileAttachmentBubble
      route={{
        conversationId:
          props.message.conversationId ??
          directConversationId(
            props.message.client,
            props.message.target,
          ),
        messageId: props.message.id,
      }}
      file={cache()?.file}
      name={props.message.fileName}
      size={props.message.fileSize}
      mimeType={props.message.mimeType ?? cache()?.mimetype}
      details={
        <Show when={showTransfer()}>
          <FileTransferDetails
            status={status()}
            received={props.message.progress?.received}
            total={props.message.fileSize}
            live={live()}
            error={props.message.error}
          />
        </Show>
      }
      action={
        <Show when={showTransfer()}>
          <FileTransferIndicator
            received={
              merging()
                ? undefined
                : props.message.progress?.received
            }
            total={props.message.fileSize}
            busy={live() || merging()}
            action={merging() ? undefined : control()}
            disabled={pending()}
            onAction={() => void act()}
          />
        </Show>
      }
    />
  );
}
