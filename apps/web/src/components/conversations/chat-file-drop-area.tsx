import {
  createEffect,
  createSignal,
  onCleanup,
  splitProps,
  type ParentProps,
} from "solid-js";
import { toast } from "solid-sonner";
import DropArea from "@/components/drop-area";
import { ChatDropOverlay } from "./chat-drop-overlay";
import { t } from "@/i18n";
import { handleDropItems } from "@/libs/utils/process-file";
import { userErrorMessage } from "@/libs/user-error";

interface ChatFileDropAreaProps extends ParentProps {
  conversationKey: string;
  disabled: boolean;
  onSendFile(file: File): Promise<void>;
  onSent?(): void;
  as?: "div" | "section";
  class?: string;
  ref?: (element: HTMLElement) => void;
  "data-slot"?: string;
}

/** Share drop preparation without coupling private and room delivery services. */
export function ChatFileDropArea(
  props: ChatFileDropAreaProps,
) {
  const [local, rest] = splitProps(props, [
    "conversationKey",
    "disabled",
    "onSendFile",
    "onSent",
    "children",
  ]);
  const [processing, setProcessing] = createSignal(false);
  let disposed = false;
  let operation:
    | { key: string; controller: AbortController }
    | undefined;
  const cancel = () =>
    operation?.controller.abort("User cancelled");
  createEffect(() => {
    const key = local.conversationKey;
    const disabled = local.disabled;
    if (operation && (key !== operation.key || disabled))
      cancel();
  });
  onCleanup(() => {
    disposed = true;
    cancel();
  });

  const drop = async (event: DragEvent) => {
    const transfer = event.dataTransfer;
    if (
      !transfer ||
      disposed ||
      local.disabled ||
      processing()
    )
      return;
    const current = {
      key: local.conversationKey,
      controller: new AbortController(),
    };
    operation = current;
    setProcessing(true);
    const { signal } = current.controller;
    const id = toast.loading(
      t("common.notification.processing_files"),
      {
        duration: Infinity,
        action: {
          label: t("common.action.cancel"),
          onClick: () =>
            current.controller.abort("User cancelled"),
        },
      },
    );
    const dismiss = () => toast.dismiss(id);
    signal.addEventListener("abort", dismiss, {
      once: true,
    });
    const valid = () =>
      !disposed &&
      !signal.aborted &&
      !local.disabled &&
      local.conversationKey === current.key;
    try {
      // Capture files/entries synchronously while the drop data store is readable.
      const files = transfer.items?.length
        ? await handleDropItems(transfer.items, signal)
        : Array.from(transfer.files ?? []);
      dismiss();
      for (const file of files) {
        if (!valid()) return;
        await local.onSendFile(file);
      }
      if (files.length && valid()) local.onSent?.();
    } catch (error) {
      if (
        valid() &&
        !(
          error instanceof Error &&
          (error.name === "AbortError" ||
            error.message === "User cancelled")
        )
      )
        toast.error(
          userErrorMessage(error, "errors.file_failed"),
        );
    } finally {
      signal.removeEventListener("abort", dismiss);
      dismiss();
      operation = undefined;
      setProcessing(false);
    }
  };

  return (
    <DropArea
      {...rest}
      disabled={local.disabled || processing()}
      onDrop={(event) => void drop(event)}
      overlay={(state) => <ChatDropOverlay state={state} />}
    >
      {local.children}
    </DropArea>
  );
}
