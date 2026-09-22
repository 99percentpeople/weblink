import { findMessageTransfer } from "@/libs/application/transfer/file-transfer-state";
import "photoswipe/style.css";
import { useAppState } from "@/libs/state/app-state-context";
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  Show,
  splitProps,
  Switch,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import {
  Progress,
  ProgressLabel,
  ProgressValueLabel,
} from "@/components/ui/progress";
import { appState } from "@/libs/state/app-state";
import {
  FileTransferer,
  TransferMode,
} from "@/libs/core/transfer/file-transferer";
import createTransferSpeed from "@/libs/hooks/transfer-speed";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { convertImageToPNG } from "@/libs/utils/conver-to-png";
import {
  FileTransferMessage,
  StoreMessage,
  TextMessage,
} from "@/libs/core/message";
import { PortableContextMenu } from "@/components/portable-contextmenu";
import {
  IconCheck,
  IconClose,
  IconContentCopy,
  IconDelete,
  IconDownload,
  IconDownloading,
  IconFileCopy,
  IconUploadFile,
  IconRestartAlt,
  IconPlayArrow,
  IconPreview,
  IconResume,
  IconSchedule,
  IconShare,
  IconDraft,
  IconPause,
} from "@/components/icons";
import { t } from "@/i18n";
import { Dynamic } from "solid-js/web";
import { createTimeAgo } from "@/libs/utils/timeago";
import { FileMetaData } from "@/libs/cache";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { catchError } from "@/libs/catch";
import { toast } from "solid-sonner";
import { Spinner } from "@/components/common/spinner";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { downloadFile } from "@/libs/utils/download-file";
import type { FileID } from "@/libs/core/ids";
import { canShareFile } from "@/libs/utils/can-share";
import { IconFile } from "@/components/icon-file";

export interface MessageCardProps extends ComponentProps<"li"> {
  message: StoreMessage;
  onLoad?: () => void;
  onDelete?: () => void;
}

export interface FileMessageCardProps {
  message: FileTransferMessage;
  onLoad?: () => void;
}

const Title = (
  props: {
    name: string;
    type?: string;
  } & ComponentProps<"div">,
) => {
  const [local, other] = splitProps(props, [
    "name",
    "type",
    "class",
  ]);
  return (
    <div class={cn("relative", local.class)} {...other}>
      {" "}
      <div
        class="absolute inset-0 space-x-1 overflow-hidden text-ellipsis
          whitespace-nowrap [&>*]:align-middle [&>svg]:inline"
      >
        <IconFile mimetype={local.type} class="size-4" />
        <span>{local.name}</span>
      </div>
    </div>
  );
};

const FileMessageCard: Component<FileMessageCardProps> = (
  props,
) => {
  const { requestFile, resumeFile, pauseFile } =
    useAppState();

  const transferer = createMemo<FileTransferer | null>(
    () => {
      if (!props.message.fid) return null;
      return (
        findMessageTransfer(
          appState.transfer.transfers,
          props.message,
        )?.transferer ?? null
      );
    },
  );

  const isSender = createMemo(() => {
    return (
      props.message.client === appState.profile.clientId
    );
  });

  const targetClientInfo = createMemo(() => {
    if (isSender()) {
      return appState.session.clientViewData[
        props.message.target
      ];
    }
    return appState.session.clientViewData[
      props.message.client
    ];
  });

  const cacheData = createMemo<FileMetaData | undefined>(
    () =>
      props.message.fid
        ? appState.cache.cacheInfo[props.message.fid]
        : undefined,
  );
  // sender local cache status
  const localCacheStatus = createMemo(() => {
    if (cacheData()?.isComplete) return "complete";
    else if (cacheData()?.isMerging) return "merging";
    else return "incomplete";
  });

  const transferStatus = createMemo(() => {
    if (transferer()) return "transfering";
    else return "paused";
  });

  const shouldShowPauseButton = createMemo(() => {
    if (transferStatus() !== "transfering") return false;

    return true;
  });

  const shouldShowResumeButton = createMemo(() => {
    if (!targetClientInfo()?.messageChannel) return false;
    if (props.message.status !== "received") return false;
    if (!props.message.transferStatus) return false;
    if (props.message.transferStatus === "complete")
      return false;
    const isCacheComplete = [
      "complete",
      "merging",
    ].includes(localCacheStatus());

    const isTransfering =
      transferStatus() === "transfering";
    if (!isSender() && isCacheComplete) return false;
    if (isTransfering) return false;

    return true;
  });

  createEffect(() => {
    if (props.message.type === "file") {
      props.onLoad?.();
    }
  });

  const transferProgress = createMemo(() => {
    if (!props.message.progress) return undefined;
    if (isSender()) {
      if (props.message.transferStatus !== "transfering")
        return undefined;
    } else {
      if (transferStatus() !== "transfering")
        return undefined;
    }
    return props.message.progress;
  });

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={cacheData()}
        fallback={
          <Title
            class="w-full max-w-[calc(100vw*0.5)]"
            type="default"
            name={props.message.fileName}
          />
        }
      >
        {(cache) => (
          <>
            <Show
              when={cache().file}
              fallback={
                <div class="flex items-center gap-1">
                  <div>
                    <Switch
                      fallback={
                        <IconSchedule class="size-8" />
                      }
                    >
                      <Match
                        when={
                          transferer()?.mode ===
                          TransferMode.Receive
                        }
                      >
                        <IconDownloading class="size-8" />
                      </Match>
                      <Match
                        when={
                          transferer()?.mode ===
                          TransferMode.Send
                        }
                      >
                        <IconUploadFile class="size-8" />
                      </Match>
                    </Switch>
                  </div>
                  <p>{cache().fileName}</p>
                </div>
              }
            >
              {(file) => {
                const url = URL.createObjectURL(file());
                const [isLong, setIsLong] =
                  createSignal(false);
                return (
                  <Switch
                    fallback={
                      <div class="flex items-center gap-1">
                        <div>
                          <IconDraft class="size-8" />
                        </div>
                        <p>{cache().fileName}</p>
                      </div>
                    }
                  >
                    <Match
                      when={cache().mimetype?.startsWith(
                        "image/",
                      )}
                    >
                      <Title
                        name={props.message.fileName}
                        type={cache().mimetype}
                      />
                      <a
                        id="pswp-item"
                        href={url}
                        target="_blank"
                        class={cn(
                          `flex h-full max-h-64 items-center justify-center
                          overflow-hidden rounded-sm hover:cursor-pointer`,
                          isLong()
                            ? "aspect-square"
                            : "aspect-video",
                        )}
                      >
                        <img
                          class="object-cover"
                          src={url}
                          alt={cache().fileName}
                          onload={(ev) => {
                            const parent =
                              ev.currentTarget
                                .parentElement!;
                            parent.dataset.pswpWidth =
                              ev.currentTarget.naturalWidth.toString();
                            parent.dataset.pswpHeight =
                              ev.currentTarget.naturalHeight.toString();
                            parent.dataset.download =
                              cache().fileName;

                            const diff =
                              ev.currentTarget
                                .naturalWidth -
                              ev.currentTarget
                                .naturalHeight;
                            if (diff <= 0) {
                              setIsLong(true);
                            }
                            props.onLoad?.();
                          }}
                        />
                      </a>
                    </Match>
                    <Match
                      when={cache().mimetype?.startsWith(
                        "video/",
                      )}
                    >
                      <Title
                        name={props.message.fileName}
                        type={cache().mimetype}
                      />
                      <a
                        id="pswp-item"
                        href={url}
                        data-pswp-type="video"
                        data-pswp-video-type={
                          cache().mimetype
                        }
                        target="_blank"
                        class={cn(
                          `relative aspect-video h-full max-h-64 overflow-hidden
                          rounded-sm`,
                          isLong()
                            ? "aspect-square"
                            : "aspect-video",
                        )}
                        data-pswp-video-src={url}
                      >
                        <video
                          class="h-full w-full object-cover"
                          src={url}
                          onLoadedMetadata={(ev) => {
                            props.onLoad?.();
                            const parent =
                              ev.currentTarget
                                .parentElement!;
                            parent.dataset.pswpWidth =
                              ev.currentTarget.videoWidth.toString();
                            parent.dataset.pswpHeight =
                              ev.currentTarget.videoHeight.toString();
                            parent.dataset.download =
                              cache().fileName;
                            const diff =
                              ev.currentTarget.videoWidth -
                              ev.currentTarget.videoHeight;
                            if (diff <= 0) {
                              setIsLong(true);
                            }
                          }}
                        ></video>
                        <div
                          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                            rounded-lg bg-black/50 p-1 text-white/80"
                        >
                          <IconPlayArrow class="size-8" />
                        </div>
                      </a>
                    </Match>
                    <Match
                      when={cache().mimetype?.startsWith(
                        "audio/",
                      )}
                    >
                      <Title
                        name={props.message.fileName}
                        type={cache().mimetype}
                      />
                      <audio
                        controls
                        src={url}
                        onLoadedMetadata={() =>
                          props.onLoad?.()
                        }
                      />
                    </Match>
                  </Switch>
                );
              }}
            </Show>

            <Show
              when={props.message.transferStatus === "init"}
            >
              <Spinner size="sm" />
            </Show>
            <Show when={transferProgress()}>
              {(progress) => {
                const speed = createTransferSpeed(
                  () => progress().received,
                );

                return (
                  <Progress
                    value={progress().received}
                    maxValue={progress().total}
                    getValueLabel={({ value, max }) =>
                      `${((value / max) * 100).toFixed(
                        2,
                      )}% ${formatBtyeSize(value)}/${formatBtyeSize(max)}`
                    }
                  >
                    <div
                      class="text-muted-foreground mb-1 flex justify-between gap-2
                        font-mono text-xs"
                    >
                      <ProgressLabel>
                        {progress().received !==
                        progress().total
                          ? speed()
                            ? `${formatBtyeSize(speed()!, 2)}/s`
                            : `waiting...`
                          : progress().received === 0
                            ? `starting...`
                            : `loading...`}
                      </ProgressLabel>
                      <ProgressValueLabel />
                    </div>
                  </Progress>
                );
              }}
            </Show>
            <Show when={localCacheStatus() === "merging"}>
              <div class="flex items-center gap-1">
                <Spinner size="sm" />
                <p class="text-muted-foreground font-mono text-sm">
                  {t("common.file_table.status.merging")}
                </p>
              </div>
            </Show>

            <div class="flex items-center justify-end gap-1">
              <Show when={cache().file}>
                {(file) => (
                  <>
                    <p class="muted mr-auto">
                      {formatBtyeSize(file().size, 1)}
                    </p>
                    <Button
                      as="a"
                      variant="ghost"
                      size="icon"
                      href={URL.createObjectURL(file())}
                      download={cache().fileName}
                    >
                      <IconDownload class="size-6" />
                    </Button>
                  </>
                )}
              </Show>
              <Show when={shouldShowPauseButton()}>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    if (isSender()) {
                      pauseFile(
                        cache().id,
                        props.message.target,
                      );
                    } else {
                      pauseFile(
                        cache().id,
                        props.message.client,
                      );
                    }
                  }}
                >
                  <IconPause class="size-6" />
                </Button>
              </Show>

              <Show when={shouldShowResumeButton()}>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    if (isSender()) {
                      resumeFile(
                        cache().id,
                        props.message.target,
                      );
                    } else {
                      requestFile(
                        props.message.client,
                        cache(),
                        true,
                      );
                    }
                  }}
                >
                  <IconResume class="size-6" />
                </Button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export const MessageContent: Component<MessageCardProps> = (
  props,
) => {
  const [local, other] = splitProps(props, [
    "class",
    "message",
    "onLoad",
  ]);
  const targetClientInfo = createMemo(
    () =>
      appState.session.clientViewData[local.message.target],
  );
  const { retryMessage } = useAppState();
  const { open: openPreviewDialog } = createPreviewDialog();

  const shouldShowRestoreButton = createMemo(() => {
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
        return await getFileFromCache(props.message.fid);
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
          onDelete={props.onDelete}
        />
      )}
    >
      {(p) => (
        <li
          class={cn(
            `flex flex-col gap-1 rounded-md p-2 shadow backdrop-blur
            select-none sm:select-text`,
            appState.profile.clientId ===
              props.message.client
              ? "self-end bg-lime-200/80 dark:bg-indigo-900/80"
              : "border-border bg-background/80 self-start border",
            local.class,
          )}
          {...p}
          {...other}
        >
          <article class="w-full text-sm break-all whitespace-pre-wrap">
            <Switch>
              <Match
                when={
                  props.message.type === "text" &&
                  props.message
                }
              >
                {(message) => (
                  <>
                    <p>{message().data}</p>
                  </>
                )}
              </Match>
              <Match
                when={
                  props.message.type === "file" &&
                  props.message
                }
              >
                {(message) => (
                  <FileMessageCard
                    message={message()}
                    onLoad={() => local.onLoad?.()}
                  />
                )}
              </Match>
            </Switch>
          </article>
          <div class="flex items-center justify-end gap-2">
            <Show when={props.message.error}>
              {(error) => (
                <Tooltip>
                  <TooltipTrigger class="text-destructive text-xs">
                    {t("client.message_error")}
                  </TooltipTrigger>
                  <TooltipContent>{error()}</TooltipContent>
                </Tooltip>
              )}
            </Show>
            <Show when={shouldShowRestoreButton()}>
              <Button
                size="icon"
                variant="outline"
                onClick={() => {
                  void retryMessage(props.message);
                }}
              >
                <IconRestartAlt class="size-6" />
              </Button>
            </Show>
          </div>
          <div
            class="text-muted-foreground flex justify-end gap-1 self-end
              text-xs"
          >
            <p>{createTimeAgo(props.message.createdAt)}</p>
            <p>
              <Switch>
                <Match
                  when={props.message.status === "sending"}
                >
                  <IconSchedule class="size-4" />
                </Match>
                <Match
                  when={props.message.status === "received"}
                >
                  <IconCheck class="size-4" />
                </Match>
                <Match
                  when={props.message.status === "error"}
                >
                  <IconClose class="text-destructive size-4" />
                </Match>
              </Switch>
            </p>
          </div>
        </li>
      )}
    </PortableContextMenu>
  );
};

export interface MessageChatProps extends ComponentProps<"div"> {
  target: string;
}

async function getFileFromCache(fid: FileID) {
  const cache = appState.cache.caches[fid];
  if (!cache) return null;
  return await cache.getFile();
}
