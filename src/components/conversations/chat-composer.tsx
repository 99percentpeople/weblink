import { userErrorMessage } from "@/libs/user-error";
import {
  createEffect,
  createSignal,
  Suspense,
  createUniqueId,
  onCleanup,
  Show,
  splitProps,
  type ComponentProps,
  type JSX,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  IconAttachFile,
  IconCamera,
  IconFolder,
  IconImage,
  IconSend,
} from "@/components/icons";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { textareaAutoResize } from "@/libs/hooks/input-resize";
import {
  handleDropItems,
  handleSelectFolder,
} from "@/libs/utils/process-file";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";
import { toast } from "solid-sonner";

import type { FileSource } from "@/libs/domain/file";
import { Library } from "lucide-solid";
import { preload } from "@/libs/utils/preload";
const pickerLoader = preload(
  () => import("@/components/files/file-picker-dialog"),
);
const FilePickerDialog = pickerLoader;

export type ChatComposerProps = Omit<
  ComponentProps<"div">,
  "onPaste"
> & {
  conversationKey?: string;
  value: string;
  onValueChange(value: string): void;
  onSendText(text: string): Promise<void> | void;
  onSendFiles(
    files: readonly FileSource[],
  ): Promise<void> | void;
  previewFile?(file: File): Promise<boolean>;
  onPaste?(event: ClipboardEvent): void;
  onSent?(): void;
  disabled?: boolean;
  textDisabled?: boolean;
  filesDisabled?: boolean;
  maxLength?: number;
  placeholder?: string;
  inputLabel?: string;
  sendLabel?: string;
  sendShortcut?: "modifier-enter" | "enter";
  hint?: JSX.Element;
  footer?: JSX.Element;
};

export function ChatComposer(props: ChatComposerProps) {
  const [local, rest] = splitProps(props, [
    "class",
    "conversationKey",
    "value",
    "onValueChange",
    "onSendText",
    "onSendFiles",
    "previewFile",
    "onPaste",
    "onSent",
    "disabled",
    "textDisabled",
    "filesDisabled",
    "maxLength",
    "placeholder",
    "inputLabel",
    "sendLabel",
    "sendShortcut",
    "hint",
    "footer",
  ]);
  const formId = createUniqueId();
  const mobile = createIsMobile();
  const [sendingText, setSendingText] = createSignal(false);
  const [sendingFiles, setSendingFiles] =
    createSignal(false);
  const [pickerTarget, setPickerTarget] =
    createSignal<string>();
  // Load once on demand; Dialog owns the content's exit animation and removal.
  const [pickerMounted, setPickerMounted] =
    createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;
  const target = () => local.conversationKey ?? "current";
  const closePicker = () => {
    setPickerTarget(undefined);
  };
  let disposed = false;
  const processing = new Set<AbortController>();
  onCleanup(() => {
    disposed = true;
    for (const controller of processing)
      controller.abort("User cancelled");
  });
  const busy = () => sendingText() || sendingFiles();
  const textDisabled = () =>
    local.disabled || local.textDisabled;
  const filesDisabled = () =>
    local.disabled || local.filesDisabled;
  createEffect(() => {
    if (
      pickerTarget() &&
      (pickerTarget() !== target() || filesDisabled())
    )
      closePicker();
    if (filesDisabled()) {
      for (const controller of processing)
        controller.abort("User cancelled");
    }
  });
  const canSendText = () =>
    !textDisabled() &&
    !sendingText() &&
    Boolean(local.value.trim()) &&
    (local.maxLength === undefined ||
      local.value.trim().length <= local.maxLength);
  const report = (error: unknown) => {
    if (
      disposed ||
      (error instanceof Error &&
        (error.message === "User cancelled" ||
          error.name === "AbortError"))
    )
      return;
    toast.error(
      userErrorMessage(error, "errors.unexpected"),
    );
  };
  const send = async () => {
    if (!canSendText()) return;
    const snapshot = local.value;
    setSendingText(true);
    try {
      await local.onSendText(snapshot.trim());
      if (!disposed) {
        if (local.value === snapshot)
          local.onValueChange("");
        local.onSent?.();
      }
    } catch (error) {
      report(error);
    } finally {
      setSendingText(false);
    }
  };
  const sendFiles = async (
    files: readonly FileSource[],
  ) => {
    if (disposed || filesDisabled() || !files.length)
      return;
    await local.onSendFiles(files);
    if (!disposed) local.onSent?.();
  };
  const prepare = async (
    read: (signal: AbortSignal) => Promise<readonly File[]>,
    preview = false,
  ) => {
    if (busy() || filesDisabled()) return;
    setSendingFiles(true);
    const conversation = target();
    const controller = new AbortController();
    processing.add(controller);
    const id = toast.loading(
      t("common.notification.processing_files"),
      {
        duration: Infinity,
        action: {
          label: t("common.action.cancel"),
          onClick: () => controller.abort("User cancelled"),
        },
      },
    );
    try {
      const files = await read(controller.signal);
      toast.dismiss(id);
      if (
        disposed ||
        controller.signal.aborted ||
        filesDisabled() ||
        conversation !== target()
      )
        return;
      if (preview && local.previewFile) {
        for (const file of files) {
          if (
            disposed ||
            filesDisabled() ||
            conversation !== target()
          )
            break;
          if (
            (await local.previewFile(file)) &&
            !controller.signal.aborted &&
            conversation === target()
          )
            await sendFiles([file]);
        }
      } else await sendFiles(files);
    } catch (error) {
      report(error);
    } finally {
      toast.dismiss(id);
      processing.delete(controller);
      setSendingFiles(false);
    }
  };
  const selected = async (
    input: HTMLInputElement,
    folder = false,
  ) => {
    const files = input.files;
    if (!files?.length) return;
    try {
      await prepare(async (signal) =>
        folder
          ? [await handleSelectFolder(files, signal)]
          : Array.from(files),
      );
    } finally {
      input.value = "";
    }
  };
  const placeholder = () =>
    local.placeholder ??
    t("client.message_editor.placeholder");
  return (
    <div
      data-slot="chat-composer"
      class={cn(
        `border-border bg-background/80 sticky bottom-0 z-10 flex
        min-w-0 shrink-0 flex-col gap-1 border-t p-2 backdrop-blur`,
        local.class,
      )}
      {...rest}
    >
      <Show when={local.hint}>
        <div class="text-muted-foreground text-[11px]">
          {local.hint}
        </div>
      </Show>
      <form
        id={formId}
        class="flex min-w-0 flex-col gap-1"
        aria-busy={busy()}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div
          class="flex gap-1 [&>[data-disabled]]:pointer-events-none
            [&>[data-disabled]]:opacity-50"
        >
          <Button
            as="label"
            variant="ghost"
            size="icon"
            aria-label={t("conversations.attach_folder")}
            title={t("conversations.attach_folder")}
            disabled={busy() || filesDisabled()}
          >
            <IconFolder class="size-6" />
            <Input
              // @ts-expect-error Browser directory picker attributes are not part of the input type.
              webkitdirectory
              mozdirectory
              directory
              type="file"
              class="hidden"
              data-attachment="folder"
              aria-label={t("conversations.attach_folder")}
              disabled={busy() || filesDisabled()}
              onChange={(event) =>
                void selected(event.currentTarget, true)
              }
            />
          </Button>
          <Button
            as="label"
            variant="ghost"
            size="icon"
            aria-label={t("conversations.attach_media")}
            title={t("conversations.attach_media")}
            disabled={busy() || filesDisabled()}
          >
            <IconImage class="size-6" />
            <Input
              multiple
              type="file"
              accept="image/*,video/*"
              class="hidden"
              data-attachment="media"
              aria-label={t("conversations.attach_media")}
              disabled={busy() || filesDisabled()}
              onChange={(event) =>
                void selected(event.currentTarget)
              }
            />
          </Button>
          <Button
            as="label"
            variant="ghost"
            size="icon"
            aria-label={t("conversations.attach_file")}
            title={t("conversations.attach_file")}
            disabled={busy() || filesDisabled()}
          >
            <IconAttachFile class="size-6" />
            <Input
              multiple
              type="file"
              accept="*/*"
              class="hidden"
              data-attachment="file"
              aria-label={t("conversations.attach_file")}
              disabled={busy() || filesDisabled()}
              onChange={(event) =>
                void selected(event.currentTarget)
              }
            />
          </Button>
          <Show when={mobile()}>
            <Button
              as="label"
              variant="ghost"
              size="icon"
              aria-label={t("conversations.capture_media")}
              title={t("conversations.capture_media")}
              disabled={busy() || filesDisabled()}
            >
              <IconCamera class="size-6" />
              <Input
                type="file"
                accept="image/*,video/*"
                capture="environment"
                class="hidden"
                data-attachment="capture"
                aria-label={t(
                  "conversations.capture_media",
                )}
                disabled={busy() || filesDisabled()}
                onChange={(event) =>
                  void selected(event.currentTarget)
                }
              />
            </Button>
          </Show>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={busy() || filesDisabled()}
            title={t("file_library.choose")}
            aria-label={t("file_library.choose")}
            onPointerEnter={() =>
              void pickerLoader.preload().catch(() => {})
            }
            onFocus={() =>
              void pickerLoader.preload().catch(() => {})
            }
            onClick={() => {
              setPickerTarget(target());
              setPickerMounted(true);
            }}
          >
            <Library class="size-6" />
          </Button>
        </div>
        <label
          class="border-input focus-within:ring-ring relative flex min-w-0
            items-center rounded-md border bg-transparent pl-3 text-sm
            shadow-sm focus-within:ring-1"
        >
          <textarea
            class="scrollbar-none my-1 max-h-36 min-w-0 flex-1 resize-none
              overflow-y-auto bg-transparent outline-none
              disabled:cursor-not-allowed disabled:opacity-60"
            ref={(element) => {
              textarea = element;
              textareaAutoResize(
                element,
                () => local.value,
              );
            }}
            rows={1}
            disabled={textDisabled()}
            maxLength={local.maxLength}
            value={local.value}
            placeholder={placeholder()}
            aria-label={local.inputLabel ?? placeholder()}
            onInput={(event) => {
              if (!textDisabled())
                local.onValueChange(
                  event.currentTarget.value,
                );
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.isComposing
              )
                return;
              const submits =
                local.sendShortcut === "enter"
                  ? !event.shiftKey
                  : event.ctrlKey || event.shiftKey;
              if (submits) {
                event.preventDefault();
                void send();
              }
            }}
            onPaste={(event) => {
              if (textDisabled()) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              local.onPaste?.(event);
              const items = event.clipboardData?.items;
              if (
                !items ||
                !Array.from(items).some(
                  (item) => item.kind === "file",
                )
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              void prepare(
                (signal) => handleDropItems(items, signal),
                true,
              );
            }}
          />
          <Button
            type="submit"
            form={formId}
            variant="ghost"
            size="icon"
            class="self-end"
            disabled={!canSendText()}
            aria-label={
              local.sendLabel ?? t("common.action.send")
            }
          >
            <IconSend class="size-6" />
          </Button>
        </label>
      </form>
      <Show when={local.footer}>{local.footer}</Show>
      <Show when={pickerMounted()}>
        <Suspense>
          <FilePickerDialog
            open={pickerTarget() !== undefined}
            disabled={filesDisabled()}
            onClose={closePicker}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              textarea?.focus();
            }}
            onSelect={(ids) => {
              if (
                pickerTarget() !== target() ||
                filesDisabled()
              ) {
                closePicker();
                return;
              }
              closePicker();
              setSendingFiles(true);
              void sendFiles(
                ids.map((localFileId) => ({
                  kind: "library" as const,
                  localFileId,
                })),
              )
                .catch(report)
                .finally(() => setSendingFiles(false));
            }}
          />
        </Suspense>
      </Show>
    </div>
  );
}
