import { userErrorMessage } from "@/libs/user-error";
import { DirectFileMessageCard as FileMessageCard } from "@/components/conversations/direct-file-message-card";
import { useAppState } from "@/libs/state/app-state-context";
import {
  Component,
  ComponentProps,
  createMemo,
  createResource,
  Match,
  Show,
  splitProps,
  Switch,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import { appState } from "@/libs/state/app-state";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { convertImageToPNG } from "@/libs/utils/conver-to-png";
import {
  FileTransferMessage,
  StoreMessage,
  TextMessage,
} from "@/libs/domain/message";
import { PortableContextMenu } from "@/components/portable-contextmenu";
import {
  IconCheck,
  IconClose,
  IconContentCopy,
  IconDelete,
  IconDownload,
  IconFileCopy,
  IconRestartAlt,
  IconPreview,
  IconShare,
  IconSchedule,
} from "@/components/icons";
import { t } from "@/i18n";
import { Dynamic } from "solid-js/web";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { catchError } from "@/libs/catch";
import { toast } from "solid-sonner";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { downloadFile } from "@/libs/utils/download-file";
import { canShareFile } from "@/libs/utils/can-share";
import { ClientAvatar } from "@/components/common/client-avatar";
import { RoomDeliverySummary } from "@/components/conversations/room-delivery-summary";
import {
  getRoomFileCache,
  RoomFileMessageCard,
} from "@/components/conversations/room-file-message-card";

export interface MessageCardProps extends ComponentProps<"li"> {
  message: StoreMessage;
  onDelete?: () => void;
  joinedPrevious?: boolean;
  joinedNext?: boolean;
}

export const MessageContent: Component<MessageCardProps> = (
  props,
) => {
  const [local, other] = splitProps(props, [
    "class",
    "message",
    "onDelete",
    "joinedPrevious",
    "joinedNext",
  ]);
  const outgoing = () =>
    appState.profile.clientId === local.message.client;
  const roomSender = createMemo(() => {
    const message = local.message;
    if (!message.room) return;
    const client =
      appState.session.clientViewData[message.client] ??
      appState.message.clients.find(
        (client) => client.clientId === message.client,
      );
    return {
      name: message.room.senderName,
      avatar:
        message.room.senderAvatar ??
        (outgoing()
          ? appState.profile.avatar
          : client?.avatar) ??
        undefined,
    };
  });
  const sentAt = createMemo(
    () => new Date(local.message.createdAt),
  );
  const fullSentAt = createMemo(() =>
    sentAt().toLocaleString(appState.options.locale),
  );
  const shortSentAt = createMemo(() =>
    sentAt().toLocaleTimeString(appState.options.locale, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
  const groupPosition = () =>
    local.joinedPrevious
      ? local.joinedNext
        ? "middle"
        : "end"
      : local.joinedNext
        ? "start"
        : "single";
  const showMetadata = () =>
    !local.joinedNext ||
    local.message.status === "sending" ||
    local.message.status === "error" ||
    !!local.message.error;
  const targetClientInfo = createMemo(
    () =>
      appState.session.clientViewData[local.message.target],
  );
  const { retryMessage } = useAppState();
  const { open: openPreviewDialog } = createPreviewDialog();

  const shouldShowRestoreButton = createMemo(() => {
    if (props.message.room) return false;
    if (!targetClientInfo()?.messageChannel) return false;
    if (props.message.status !== "error") return false;
    return true;
  });

  const contentOptions = {
    text: (props: {
      message: TextMessage;
      close: () => void;
    }) => {
      const shareableData = createMemo(() => {
        if (!navigator.canShare) return null;
        const shareData: ShareData = {
          text: props.message.data,
        };
        return navigator.canShare(shareData)
          ? shareData
          : null;
      });
      return (
        <>
          <ContextMenuItem
            class="gap-2"
            onSelect={async () => {
              const [err] = await catchError(
                navigator.clipboard.writeText(
                  props.message.data,
                ),
              );
              if (err) {
                toast.error(
                  t("common.notification.copy_failed"),
                );
              } else {
                toast.success(
                  t("common.notification.copy_success"),
                );
              }
              props.close();
            }}
          >
            <IconContentCopy class="size-4" />
            {t("common.action.copy")}
          </ContextMenuItem>
          <Show when={shareableData()}>
            {(shareData) => (
              <ContextMenuItem
                class="gap-2"
                onSelect={async () => {
                  props.close();
                  const [err] = await catchError(
                    navigator.share(shareData()),
                  );
                  if (err) {
                    console.error(err);
                    toast.error(
                      t(
                        "common.notification.share_failed",
                        {
                          error: err.message,
                        },
                      ),
                    );
                  }
                }}
              >
                <IconShare class="size-4" />
                {t("common.action.share")}
              </ContextMenuItem>
            )}
          </Show>
        </>
      );
    },
    file: (props: {
      message: FileTransferMessage;
      close: () => void;
    }) => {
      const [file] = createResource(async () => {
        if (!props.message.fid) return null;
        return await getFileFromCache(props.message);
      });
      const shareableData = createMemo(() => {
        const f = file();
        if (!f) return null;
        if (!canShareFile(f)) return null;
        const shareData: ShareData = {
          files: [f],
        };
        return shareData;
      });

      return (
        <>
          <Show when={navigator.clipboard !== undefined}>
            <ContextMenuItem
              class="gap-2"
              onSelect={async () => {
                const [err] = await catchError(
                  navigator.clipboard.writeText(
                    props.message.fileName,
                  ),
                );

                if (err) {
                  toast.error(
                    t("common.notification.copy_failed"),
                  );
                } else {
                  toast.success(
                    t("common.notification.copy_success"),
                  );
                }

                props.close();
              }}
            >
              <IconContentCopy class="size-4" />
              {t("common.action.copy_file_name")}
            </ContextMenuItem>
          </Show>
          <Show when={file()}>
            {(f) => (
              <>
                <Show
                  when={navigator.clipboard !== undefined}
                >
                  <Show
                    when={props.message.mimeType?.startsWith(
                      "image",
                    )}
                  >
                    <ContextMenuItem
                      class="gap-2"
                      onSelect={async () => {
                        props.close();
                        const convertedPng =
                          await convertImageToPNG(f());
                        const item = new ClipboardItem({
                          [convertedPng.type]: convertedPng,
                        });
                        const [err] = await catchError(
                          navigator.clipboard.write([item]),
                        );

                        if (err) {
                          toast.error(
                            t(
                              "common.notification.copy_failed",
                            ),
                          );
                        } else {
                          toast.success(
                            t(
                              "common.notification.copy_success",
                            ),
                          );
                        }
                      }}
                    >
                      <IconFileCopy class="size-4" />
                      {t("common.action.copy_as_png")}
                    </ContextMenuItem>
                    <Show
                      when={
                        (ClipboardItem as any).supports?.(
                          "image/svg+xml",
                        ) && f().type === "image/svg+xml"
                      }
                    >
                      <ContextMenuItem
                        class="gap-2"
                        onSelect={async () => {
                          const item = new ClipboardItem({
                            [f().type]: f(),
                          });
                          const [err] = await catchError(
                            navigator.clipboard.write([
                              item,
                            ]),
                          );

                          if (err) {
                            toast.error(
                              t(
                                "common.notification.copy_failed",
                              ),
                            );
                          } else {
                            toast.success(
                              t(
                                "common.notification.copy_success",
                              ),
                            );
                          }

                          props.close();
                        }}
                      >
                        <IconFileCopy class="size-4" />
                        {t("common.action.copy_as_svg")}
                      </ContextMenuItem>
                    </Show>
                  </Show>
                </Show>
                <ContextMenuItem
                  class="gap-2"
                  onSelect={() => {
                    props.close();
                    openPreviewDialog(f());
                  }}
                >
                  <IconPreview class="size-4" />
                  {t("common.action.preview")}
                </ContextMenuItem>
                <Show when={shareableData()}>
                  {(shareData) => (
                    <ContextMenuItem
                      class="gap-2"
                      onSelect={async () => {
                        props.close();
                        const [err] = await catchError(
                          navigator.share(shareData()),
                        );
                        if (err) {
                          console.error(err);
                        }
                      }}
                    >
                      <IconShare class="size-4" />
                      {t("common.action.share")}
                    </ContextMenuItem>
                  )}
                </Show>
                <ContextMenuItem
                  class="gap-2"
                  onSelect={async () => {
                    props.close();
                    downloadFile(f());
                  }}
                >
                  <IconDownload class="size-4" />
                  {t("common.action.download")}
                </ContextMenuItem>
              </>
            )}
          </Show>
        </>
      );
    },
  } as const;

  const Menu = (props: {
    message: StoreMessage;
    close: () => void;
    onDelete?: () => void;
  }) => {
    return (
      <>
        <Dynamic
          component={contentOptions[props.message.type]}
          message={props.message as any}
          close={props.close}
        />
        <Show when={props.onDelete !== undefined}>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            class="gap-2"
            onSelect={() => {
              props.onDelete?.();
              props.close();
            }}
          >
            <IconDelete class="size-4" />
            {t("common.action.delete")}
          </ContextMenuItem>
        </Show>
      </>
    );
  };

  return (
    <PortableContextMenu
      menu={(close) => (
        <Menu
          message={props.message}
          close={close}
          onDelete={local.onDelete}
        />
      )}
    >
      {(p) => (
        <li
          data-side={outgoing() ? "outgoing" : "incoming"}
          data-group={groupPosition()}
          class={cn(
            "flex w-full min-w-0 flex-col",
            local.class,
          )}
          {...other}
        >
          <div
            data-slot="message-row"
            class={cn(
              "flex w-full min-w-0 items-end gap-1.5",
              outgoing()
                ? "flex-row-reverse justify-start"
                : "justify-start",
            )}
          >
            <Show when={roomSender()}>
              {(sender) => (
                <ClientAvatar
                  data-slot="message-sender-avatar"
                  name={sender().name}
                  avatar={sender().avatar}
                  class="size-7 shrink-0 self-start text-[10px]"
                  title={sender().name}
                  aria-label={sender().name}
                  role="img"
                />
              )}
            </Show>
            <div
              data-slot="message-bubble"
              title={fullSentAt()}
              class={cn(
                `text-foreground flex max-w-[88%] min-w-0 flex-col gap-1.5
                rounded-2xl border px-3.5 py-2.5 shadow-sm select-none
                sm:max-w-[80%] sm:select-text lg:max-w-[75%]`,
                local.message.type === "file"
                  ? "w-88"
                  : "w-fit",
                local.joinedNext && "py-2",
                outgoing()
                  ? "border-primary/15 bg-primary/10 self-end"
                  : "border-border/60 bg-background/90 self-start",
                outgoing()
                  ? cn(
                      local.joinedPrevious &&
                        "rounded-tr-md",
                      (local.joinedNext ||
                        !local.joinedPrevious) &&
                        "rounded-br-md",
                    )
                  : cn(
                      local.joinedPrevious &&
                        "rounded-tl-md",
                      (local.joinedNext ||
                        !local.joinedPrevious) &&
                        "rounded-bl-md",
                    ),
              )}
              {...p}
            >
              <Show
                when={
                  local.message.room &&
                  !local.joinedPrevious &&
                  !outgoing()
                }
              >
                <p class="text-primary text-xs font-medium">
                  {local.message.room?.senderName}
                </p>
              </Show>
              <article
                class="w-full min-w-0 text-sm leading-relaxed
                  [overflow-wrap:anywhere]"
              >
                <Switch>
                  <Match
                    when={
                      props.message.type === "text" &&
                      props.message
                    }
                  >
                    {(message) => (
                      <p class="whitespace-pre-wrap">
                        {message().data}
                      </p>
                    )}
                  </Match>
                  <Match
                    when={
                      props.message.type === "file" &&
                      props.message
                    }
                  >
                    {(message) => (
                      <Show
                        when={message().room}
                        fallback={
                          <FileMessageCard
                            message={message()}
                          />
                        }
                      >
                        <RoomFileMessageCard
                          message={message()}
                        />
                      </Show>
                    )}
                  </Match>
                </Switch>
              </article>
              <Show when={local.joinedNext}>
                <time
                  class="sr-only"
                  dateTime={sentAt().toISOString()}
                >
                  {fullSentAt()}
                </time>
              </Show>
              <Show when={showMetadata()}>
                <div
                  data-slot="message-meta"
                  class="text-muted-foreground flex flex-wrap items-center
                    justify-end gap-x-1.5 gap-y-1 text-[11px] leading-4
                    tabular-nums"
                >
                  <Show when={props.message.error}>
                    {(error) => (
                      <Tooltip>
                        <TooltipTrigger class="text-destructive text-[11px]">
                          {t("client.message_error")}
                        </TooltipTrigger>
                        <TooltipContent>
                          {userErrorMessage(error())}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </Show>
                  <Show when={shouldShowRestoreButton()}>
                    <Button
                      size="icon"
                      variant="ghost"
                      class="size-6 rounded-full"
                      aria-label={t("tasks.resume")}
                      onClick={() => {
                        void retryMessage(props.message);
                      }}
                    >
                      <IconRestartAlt class="size-3.5" />
                    </Button>
                  </Show>
                  <Show when={!local.joinedNext}>
                    <time
                      dateTime={sentAt().toISOString()}
                      title={fullSentAt()}
                    >
                      {shortSentAt()}
                    </time>
                  </Show>
                  <Show
                    when={outgoing() && !local.message.room}
                  >
                    <span
                      class="inline-flex shrink-0 items-center"
                      aria-hidden="true"
                    >
                      <Switch>
                        <Match
                          when={
                            props.message.status ===
                            "sending"
                          }
                        >
                          <IconSchedule class="size-3.5" />
                        </Match>
                        <Match
                          when={
                            props.message.status ===
                            "received"
                          }
                        >
                          <IconCheck class="size-3.5" />
                        </Match>
                        <Match
                          when={
                            props.message.status === "error"
                          }
                        >
                          <IconClose class="text-destructive size-3.5" />
                        </Match>
                      </Switch>
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
            <Show
              when={
                outgoing() &&
                local.message.room &&
                local.message
              }
            >
              {(message) => (
                <RoomDeliverySummary message={message()} />
              )}
            </Show>
          </div>
        </li>
      )}
    </PortableContextMenu>
  );
};

export interface MessageChatProps extends ComponentProps<"div"> {
  target: string;
}

async function getFileFromCache(
  message: FileTransferMessage,
) {
  if (
    !message.fid ||
    (message.room && !getRoomFileCache(message))
  )
    return null;
  const cache = appState.cache.caches[message.fid];
  if (!cache) return null;
  return await cache.getFile();
}
