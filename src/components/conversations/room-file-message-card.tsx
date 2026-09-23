import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useAppState } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import type {
  FileTransferMessage,
  RoomFileTransferState,
} from "@/libs/domain/message";
import type { FileMetaData } from "@/libs/domain/file";
import { findMessageTransfer } from "@/libs/application/transfer/file-transfer-state";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { Info } from "lucide-solid";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileAttachmentBubble } from "./file-attachment-bubble";
import {
  FileTransferIndicator,
  FileTransferDetails,
} from "./file-transfer-indicator";

/** A coincident file id must never expose another offer's cached bytes. */
export function getRoomFileCache(
  message: FileTransferMessage,
): FileMetaData | undefined {
  const cache = message.fid
    ? appState.cache.cacheInfo[message.fid]
    : undefined;
  return cache?.roomAttachment &&
    cache.id === message.fid &&
    cache.roomOfferId === message.id &&
    cache.from === message.client &&
    cache.fileName === message.fileName &&
    cache.fileSize === message.fileSize &&
    cache.chunkSize === message.chunkSize &&
    cache.lastModified === message.lastModified &&
    (cache.mimetype ?? "") === (message.mimeType ?? "")
    ? cache
    : undefined;
}

function transferStatus(
  state: RoomFileTransferState,
  live: boolean,
) {
  return t(
    `tasks.status.${state.status === "complete" ? "completed" : live ? (state.progress ? "running" : "waiting") : state.status === "error" ? "failed" : "paused"}`,
  );
}

/** The sender previews local bytes; recipients fetch them only on request. */
export function RoomFileMessageCard(props: {
  message: FileTransferMessage;
}) {
  const state = useAppState();
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const outgoing = () =>
    props.message.client === appState.profile.clientId;
  const cache = () => getRoomFileCache(props.message);
  const incomingTransfer = createMemo(() =>
    findMessageTransfer(
      appState.transfer.transfers,
      props.message,
    ),
  );
  const outgoingTransfers = createMemo(() =>
    Object.values(appState.transfer.transfers).filter(
      (entry) =>
        entry?.messageId === props.message.id &&
        entry.fileId === props.message.fid &&
        entry.session.clientId === props.message.client &&
        entry.transferer.mode === TransferMode.Send,
    ),
  );
  const recipients = createMemo(() => [
    ...new Set([
      ...Object.keys(props.message.roomTransfers ?? {}),
      ...outgoingTransfers().flatMap((entry) =>
        entry ? [entry.session.targetClientId] : [],
      ),
    ]),
  ]);
  const recipientTransfer = (peerId: string) =>
    outgoingTransfers().find(
      (entry) => entry?.session.targetClientId === peerId,
    );
  const peerName = (peerId: string) =>
    appState.session.clientViewData[peerId]?.name ??
    appState.message.clients.find(
      (client) => client.clientId === peerId,
    )?.name ??
    peerId;
  const canRequest = () => {
    const peer =
      appState.session.clientViewData[props.message.client];
    return (
      !!props.message.fid &&
      props.message.conversationId ===
        state.activeRoomConversationId() &&
      peer?.onlineStatus === "online" &&
      peer.messageChannel &&
      state.roomFileCapabilities?.()[
        props.message.client
      ] !== "unsupported"
    );
  };
  const action = async (run: () => Promise<void>) => {
    if (pending()) return;
    setPending(true);
    try {
      await run();
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
  const request = () => {
    if (!canRequest()) return;
    return action(() =>
      state.requestRoomFile(props.message),
    );
  };
  const incomingState = (): RoomFileTransferState => ({
    status: props.message.transferStatus,
    progress: props.message.progress,
    error: props.message.error,
  });
  const needsFile = () => !outgoing() && !cache()?.file;
  const merging = () => !!cache()?.isMerging;
  const pause = (peerId: string) =>
    action(() =>
      state.pauseFile(props.message.fid!, peerId),
    );
  return (
    <div class="min-w-0" data-slot="room-file-card">
      <FileAttachmentBubble
        route={{
          conversationId: props.message.conversationId!,
          messageId: props.message.id,
        }}
        file={cache()?.file}
        name={props.message.fileName}
        size={props.message.fileSize}
        mimeType={props.message.mimeType}
        details={
          <Show
            when={
              needsFile() &&
              (props.message.transferStatus ||
                incomingTransfer() ||
                merging())
            }
          >
            <FileTransferDetails
              status={
                merging()
                  ? t("common.file_table.status.merging")
                  : transferStatus(
                      incomingState(),
                      !!incomingTransfer(),
                    )
              }
              received={props.message.progress?.received}
              total={props.message.fileSize}
              live={!!incomingTransfer()}
              error={props.message.error}
            />
          </Show>
        }
        action={
          <>
            <Show when={outgoing()}>
              <button
                type="button"
                class="hover:bg-foreground/10 focus-visible:ring-ring flex size-8
                  shrink-0 items-center justify-center rounded-full
                  outline-none focus-visible:ring-2"
                aria-label={t(
                  "conversations.room_file_details",
                )}
                title={t("conversations.room_file_details")}
                onClick={() => setDetailsOpen(true)}
              >
                <Info class="size-4" />
                <span class="sr-only">
                  {t("conversations.room_file_details")}
                </span>
              </button>
            </Show>
            <Show when={needsFile()}>
              <FileTransferIndicator
                received={
                  merging()
                    ? undefined
                    : props.message.progress?.received
                }
                total={props.message.fileSize}
                busy={
                  !!incomingTransfer() ||
                  pending() ||
                  merging()
                }
                action={
                  merging()
                    ? undefined
                    : incomingTransfer()
                      ? "pause"
                      : props.message.transferStatus
                        ? "resume"
                        : "request"
                }
                disabled={
                  pending() ||
                  (!incomingTransfer() && !canRequest())
                }
                onAction={() =>
                  void (incomingTransfer()
                    ? pause(props.message.client)
                    : request())
                }
              />
            </Show>
          </>
        }
      >
        <Show
          when={
            needsFile() &&
            !incomingTransfer() &&
            !merging() &&
            !canRequest()
          }
        >
          <p class="text-muted-foreground text-xs">
            {t(
              "conversations.room_file_sender_unavailable",
            )}
          </p>
        </Show>
        <Show when={outgoing()}>
          <Show when={!cache()?.file}>
            <p class="text-muted-foreground text-xs">
              {t("conversations.room_file_missing")}
            </p>
          </Show>
        </Show>
      </FileAttachmentBubble>
      <Show when={outgoing()}>
        <Dialog
          open={detailsOpen()}
          onOpenChange={setDetailsOpen}
        >
          <DialogContent class="flex min-w-0 flex-col sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("conversations.room_file_details")}
              </DialogTitle>
              <DialogDescription class="[overflow-wrap:anywhere]">
                {props.message.fileName}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Show when={detailsOpen()}>
                <Show
                  when={recipients().length}
                  fallback={
                    <p class="text-muted-foreground text-xs">
                      {t("conversations.room_file_offer")}
                    </p>
                  }
                >
                  <div class="space-y-3">
                    <For each={recipients()}>
                      {(peerId) => {
                        const progress = () =>
                          props.message.roomTransfers?.[
                            peerId
                          ] ?? {};
                        const live = () =>
                          !!recipientTransfer(peerId);
                        return (
                          <div
                            class="flex min-w-0 items-center gap-2"
                            data-transfer-recipient={peerId}
                          >
                            <div class="min-w-0 flex-1">
                              <p class="truncate text-xs font-medium">
                                {peerName(peerId)}
                              </p>
                              <div class="text-muted-foreground mt-0.5">
                                <FileTransferDetails
                                  status={transferStatus(
                                    progress(),
                                    live(),
                                  )}
                                  received={
                                    progress().progress
                                      ?.received
                                  }
                                  total={
                                    props.message.fileSize
                                  }
                                  live={live()}
                                  error={progress().error}
                                />
                              </div>
                            </div>
                            <FileTransferIndicator
                              received={
                                progress().progress
                                  ?.received
                              }
                              total={props.message.fileSize}
                              complete={
                                progress().status ===
                                "complete"
                              }
                              busy={live()}
                              action={
                                live() ? "pause" : undefined
                              }
                              label={`${t("tasks.pause")} · ${peerName(peerId)}`}
                              disabled={pending()}
                              onAction={() =>
                                void pause(peerId)
                              }
                            />
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </DialogBody>
          </DialogContent>
        </Dialog>
      </Show>
    </div>
  );
}
