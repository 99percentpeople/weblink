import { useWebRTC } from "@/libs/core/rtc-context";
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  Match,
  Show,
  splitProps,
  Switch,
} from "solid-js";

import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Client } from "@/libs/core/type";
import { textareaAutoResize } from "@/libs/hooks/input-resize";
import { cn } from "@/libs/cn";
import {
  Progress,
  ProgressLabel,
  ProgressValueLabel,
} from "../ui/progress";
import { clientProfile } from "@/libs/core/store";
import { ChunkCache } from "@/libs/cache/chunk-cache";
import {
  FileTransmitter,
  TransferMode,
} from "@/libs/core/file-transmitter";
import createTransferSpeed from "@/libs/hooks/transfer-speed";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { ClientID, ClientInfo } from "@/libs/core/type";
import {
  ContextMenuItem,
  ContextMenuShortcut,
} from "../ui/context-menu";

import { convertImageToPNG } from "@/libs/utils/conver-to-png";

import "photoswipe/style.css";
import {
  FileTransferMessage,
  messageStores,
  StoreMessage,
} from "@/libs/core/messge";
import { cacheManager } from "@/libs/services/cache-serivce";
import { transferManager } from "@/libs/services/transfer-service";
import { PortableContextMenu } from "../portable-contextmenu";
import {
  IconAttachFile,
  IconAudioFileFilled,
  IconCameraFilled,
  IconCameraVideoFilled,
  IconContentCopy,
  IconDelete,
  IconDownload,
  IconDownloading,
  IconFileCopy,
  IconFileUpload,
  IconInsertDriveFile,
  IconMicFilled,
  IconPhotoFilled,
  IconRestore,
  IconSchedule,
  IconSend,
  IconVideoFileFilled,
} from "../icons";
import { sessionService } from "@/libs/services/session-service";
import { t } from "@/i18n";
export interface MessageCardProps {
  message: StoreMessage;
}

export interface FileMessageCardProps {
  message: FileTransferMessage;
}
const FileMessageCard: Component<FileMessageCardProps> = (
  props,
) => {
  const { requestFile } = useWebRTC();
  const cache = createMemo<ChunkCache | null>(
    () => cacheManager.caches[props.message.fid] ?? null,
  );

  const transferer = createMemo<FileTransmitter | null>(
    () =>
      transferManager.transferers[props.message.fid] ??
      null,
  );

  const clientInfo = createMemo(
    () => sessionService.clientInfo[props.message.client],
  );

  // createEffect(async () => {
  //   const cacheData = cache();
  //   if (cacheData) {
  //     const info = await cacheData.getInfo();
  //     const done = await cacheData.isDone();
  //     if (done && !info?.file) {
  //       messageStores.addCache(cacheData);
  //       cacheData.getFile();
  //     }
  //   }
  // });

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={cache()?.info()}
        fallback={
          <p class="italic text-muted-foreground">
            Deleted
          </p>
        }
      >
        {(info) => (
          <>
            <Show when={props.message.status}>
              {(status) => (
                <>
                  <Show
                    when={info().file}
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
                              <IconFileUpload class="size-8" />
                            </Match>
                          </Switch>
                        </div>
                        <p>{info().fileName}</p>
                      </div>
                    }
                  >
                    {(file) => {
                      const url =
                        URL.createObjectURL(file());

                      return (
                        <Switch
                          fallback={
                            <div class="flex items-center gap-1">
                              <div>
                                <IconInsertDriveFile class="size-8" />
                              </div>

                              <p>{info().fileName}</p>
                            </div>
                          }
                        >
                          <Match
                            when={info().mimetype?.startsWith(
                              "image/",
                            )}
                          >
                            <p class="relative">
                              {" "}
                              <span
                                class="absolute left-0 right-0 overflow-hidden text-ellipsis
                                  whitespace-nowrap"
                              >
                                <IconPhotoFilled class="inline size-4 align-middle" />{" "}
                                {info().fileName}
                              </span>
                            </p>

                            <a
                              id="image"
                              href={url}
                              target="_blank"
                            >
                              <img
                                class="flex max-h-48 rounded-sm bg-muted hover:cursor-pointer
                                  lg:max-h-72 xl:max-h-96"
                                src={url}
                                onload={(ev) => {
                                  const parent =
                                    ev.currentTarget
                                      .parentElement!;
                                  parent.dataset.pswpWidth =
                                    ev.currentTarget.naturalWidth.toString();
                                  parent.dataset.pswpHeight =
                                    ev.currentTarget.naturalHeight.toString();
                                  parent.dataset.download =
                                    info().fileName;
                                }}
                              />
                            </a>
                          </Match>
                          <Match
                            when={info().mimetype?.startsWith(
                              "video/",
                            )}
                          >
                            <p class="relative">
                              {" "}
                              <span
                                class="absolute left-0 right-0 overflow-hidden text-ellipsis
                                  whitespace-nowrap"
                              >
                                <IconVideoFileFilled class="inline size-4 align-middle" />{" "}
                                {info().fileName}
                              </span>
                            </p>
                            <video
                              class="max-h-60 lg:max-h-72 xl:max-h-96"
                              controls
                              src={url}
                            />
                          </Match>
                          <Match
                            when={info().mimetype?.startsWith(
                              "audio/",
                            )}
                          >
                            <p class="relative">
                              {" "}
                              <span
                                class="absolute left-0 right-0 overflow-hidden text-ellipsis
                                  whitespace-nowrap"
                              >
                                <IconAudioFileFilled class="inline size-4 align-middle" />{" "}
                                {info().fileName}
                              </span>
                            </p>
                            <audio
                              class="max-h-60 lg:max-h-72 xl:max-h-96"
                              controls
                              src={url}
                            />
                          </Match>
                        </Switch>
                      );
                    }}
                  </Show>

                  <Switch>
                    <Match when={status() === "processing"}>
                      <Show when={props.message.progress}>
                        {(progress) => {
                          const speed = createTransferSpeed(
                            () => progress().received,
                          );

                          return (
                            <Progress
                              value={progress().received}
                              maxValue={progress().total}
                              getValueLabel={({
                                value,
                                max,
                              }) =>
                                `${(
                                  (value / max) *
                                  100
                                ).toFixed(
                                  2,
                                )}% ${formatBtyeSize(value)}/${formatBtyeSize(max)}`
                              }
                            >
                              <div
                                class="mb-1 flex justify-between gap-2 font-mono text-sm
                                  text-muted-foreground"
                              >
                                <ProgressLabel>
                                  {progress().received !==
                                  progress().total
                                    ? speed()
                                      ? `${formatBtyeSize(speed()!, 2)}/s`
                                      : `waiting...`
                                    : progress()
                                          .received === 0
                                      ? `starting...`
                                      : `loading...`}
                                </ProgressLabel>
                                <ProgressValueLabel />
                              </div>
                            </Progress>
                          );
                        }}
                      </Show>
                    </Match>
                    <Match when={status() === "merging"}>
                      <p class="font-mono text-sm text-muted-foreground">
                        merging...
                      </p>
                    </Match>
                  </Switch>

                  <div class="flex items-center justify-end gap-1">
                    <Show when={info().file}>
                      {(file) => (
                        <>
                          <p class="muted mr-auto">
                            {formatBtyeSize(file().size, 1)}
                          </p>
                          <Button
                            as="a"
                            variant="ghost"
                            size="icon"
                            href={URL.createObjectURL(
                              file(),
                            )}
                            download={info().fileName}
                          >
                            <IconDownload class="size-6" />
                          </Button>
                        </>
                      )}
                    </Show>
                    <Show
                      when={
                        !transferer() &&
                        status() !== "merging" &&
                        !info().file &&
                        clientInfo()?.onlineStatus ===
                          "online"
                      }
                    >
                      <Button
                        size="icon"
                        onClick={() => {
                          requestFile(
                            props.message.client,
                            info().id,
                          );
                        }}
                      >
                        <IconRestore class="size-6" />
                      </Button>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </>
        )}
      </Show>

      <Show when={props.message.error}>
        {(error) => (
          <p class="text-xs text-destructive">
            {error().message}
          </p>
        )}
      </Show>
    </div>
  );
};

export const MessageContent: Component<MessageCardProps> = (
  props,
) => {
  const Menu = (props: {
    message: StoreMessage;
    close: () => void;
  }) => {
    return (
      <>
        <Switch>
          <Match when={props.message.type === "text"}>
            <ContextMenuItem
              class="gap-2"
              onSelect={() => {
                if (props.message.type === "text")
                  navigator.clipboard.writeText(
                    props.message.data,
                  );

                props.close();
              }}
            >
              <IconContentCopy class="size-4" />
              {t("common.action.copy")}
            </ContextMenuItem>
          </Match>
          <Match when={props.message.type === "file"}>
            <ContextMenuItem
              class="gap-2"
              onSelect={() => {
                if (props.message.type === "file")
                  navigator.clipboard.writeText(
                    props.message.fileName,
                  );

                props.close();
              }}
            >
              <IconContentCopy class="size-4" />
              {t("common.action.copy")}
            </ContextMenuItem>
            <Show
              when={(
                props.message as FileTransferMessage
              ).mimeType?.startsWith("image")}
            >
              <ContextMenuItem
                class="gap-2"
                onSelect={async () => {
                  if (props.message.type === "file") {
                    const cache = cacheManager.getCache(
                      props.message.fid,
                    );
                    if (!cache) return;
                    const file = await cache.getFile();
                    if (!file) return;
                    const blob =
                      await convertImageToPNG(file);
                    const item = new ClipboardItem({
                      [blob.type]: blob,
                    });
                    navigator.clipboard.write([item]);
                  }

                  props.close();
                }}
              >
                <IconFileCopy class="size-4" />
                {t("common.action.copy_image")}
              </ContextMenuItem>
            </Show>
          </Match>
        </Switch>

        <ContextMenuItem
          class="gap-2"
          onSelect={() => {
            messageStores.deleteMessage(props.message.id);
            props.close();
          }}
        >
          <IconDelete class="size-4" />
          {t("common.action.delete")}
        </ContextMenuItem>
      </>
    );
  };

  return (
    <PortableContextMenu
      menu={(close) => (
        <Menu message={props.message} close={close} />
      )}
      content={(p) => (
        <li
          class={cn(
            "flex select-none flex-col gap-1 rounded-md p-2 shadow",
            clientProfile.clientId === props.message.client
              ? "self-end bg-lime-200 dark:bg-indigo-900"
              : "self-start border border-border",
          )}
          {...p}
        >
          <article class="w-fit select-text whitespace-pre-wrap break-all text-sm">
            <Switch>
              <Match
                when={
                  props.message.type === "text" &&
                  props.message
                }
              >
                {(message) => message().data}
              </Match>
              <Match
                when={
                  props.message.type === "file" &&
                  props.message
                }
              >
                {(message) => (
                  <FileMessageCard message={message()} />
                )}
              </Match>
            </Switch>
          </article>

          <p class="self-end text-xs text-muted-foreground">
            {new Date(
              props.message.createdAt,
            ).toLocaleTimeString()}
          </p>
        </li>
      )}
    />
  );
};

export interface MessageChatProps
  extends ComponentProps<"div"> {
  target: string;
}

export const ChatBar: Component<
  ComponentProps<"div"> & { client: Client }
> = (props) => {
  const [local, other] = splitProps(props, [
    "client",
    "class",
  ]);
  const { send } = useWebRTC();
  const [text, setText] = createSignal("");

  const onSend = async (target: ClientID) => {
    if (text().trim().length === 0) return;
    if (
      await send(text(), {
        target: target,
      })
    ) {
      setText("");
    }
  };

  return (
    <div
      class={cn(
        `sticky bottom-0 z-10 flex flex-col gap-1 border-t
        border-border bg-background/80 backdrop-blur`,
        local.class,
      )}
      {...other}
    >
      <form
        id="send"
        onSubmit={async (ev) => {
          ev.preventDefault();
          onSend(local.client.clientId);
        }}
      >
        <Textarea
          ref={(ref) => {
            createEffect(() => {
              textareaAutoResize(ref, text);
            });
          }}
          rows="1"
          class="max-h-48 resize-none"
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              if (e.ctrlKey || e.shiftKey) {
                e.preventDefault();
                await onSend(local.client.clientId);
              }
            }
          }}
          placeholder={t("chat.message_editor.placeholder")}
          value={text()}
          onInput={(ev) => setText(ev.currentTarget.value)}
        />
      </form>
      <div class="flex justify-end gap-1">
        <Button as="label" variant="ghost" size="icon">
          <IconAttachFile class="size-6" />
          <Input
            multiple
            class="hidden"
            type="file"
            onChange={(ev) => {
              const files = ev.currentTarget.files;
              if (!files) return;
              for (let i = 0; i < files.length; i++) {
                const file = files.item(i)!;
                send(file, {
                  target: local.client.clientId,
                });
              }
            }}
          />
        </Button>

        <Button
          form="send"
          type="submit"
          variant="ghost"
          size="icon"
        >
          <IconSend class="size-6" />
        </Button>
      </div>
    </div>
  );
};
