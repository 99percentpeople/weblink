import { toast } from "solid-sonner";
import { t } from "@/i18n";
import {
  createEffect,
  createMemo,
  onCleanup,
} from "solid-js";
import {
  resolveRemoteFileLimit,
  MAX_REMOTE_FILE_BYTES,
} from "@/libs/domain/protocol/remote-file-limits";
import { platform } from "@/libs/platform/runtime";
import { browserClipboardContent } from "@/libs/application/browser-clipboard-files";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import type {
  PointerState,
  RemotePointer,
} from "@/libs/domain/remote-control/pointer";
import {
  fromPaste,
  browserClipboardFormats,
  toNativeClipboard,
  writeBrowserClipboard,
  type ClipboardContent,
} from "@/libs/application/clipboard-content";

export function createRemoteClipboard(props: {
  clientId?: string;
  clipboard?: AppStateContextProps["remoteClipboard"];
  control: RemotePointer;
  state: PointerState;
  enabled: boolean;
}) {
  const access = appState.capabilities.clipboard;
  const reportFileLimit = (error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : String(error);
    if (/files exceed|file.*size limit/i.test(message))
      toast.error(
        t("remote_control.clipboard_transfer.failed"),
        { description: message },
      );
  };
  let disposed = false;
  let pendingCancel: (() => void) | undefined;
  const pendingPastes: {
    ready(): boolean;
    run(): Promise<void>;
  }[] = [];
  onCleanup(() => {
    disposed = true;
    pendingPastes.length = 0;
    pendingCancel?.();
  });
  const authorized = () =>
    !disposed &&
    !!props.clipboard &&
    !!props.clientId &&
    props.enabled &&
    ["active", "activating"].includes(props.state) &&
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ).clipboard;
  const enabled = () =>
    authorized() && props.state === "active";
  const destination = () =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ).clipboardFiles;
  const receiveGrant = createMemo(() =>
    authorized() &&
    access.ready &&
    (access.write || destination() === "cache")
      ? props.control.clipboardGrant()
      : undefined,
  );
  let busy = false;
  let queuedChange: (() => void) | undefined;
  const startNextOperation = () => {
    const paste = pendingPastes.shift();
    if (paste) {
      busy = true;
      void paste
        .run()
        .catch(reportFileLimit)
        .finally(startNextOperation);
      return;
    }
    busy = false;
    const next = queuedChange;
    queuedChange = undefined;
    next?.();
  };
  const current = (grant: string) =>
    authorized() &&
    props.control.clipboardGrant() === grant;
  const write = async (
    content: ClipboardContent,
    grant: string,
  ) => {
    if (!access.write || !current(grant))
      throw new Error("Clipboard write unavailable");
    if (access.native) {
      const entries = await toNativeClipboard(content);
      if (!current(grant)) throw new Error("Control ended");
      await platform.clipboard!.write(
        entries,
        undefined,
        MAX_REMOTE_FILE_BYTES,
      );
    } else await writeBrowserClipboard(content);
  };
  const reportCopyError = (error: unknown) => {
    if (
      error instanceof Error &&
      error.name !== "AbortError"
    )
      toast.error(
        t("remote_control.clipboard_write_failed"),
        {
          description:
            error.message === "clipboard-file-unsupported"
              ? t(
                  "remote_control.clipboard_file_unsupported",
                )
              : error.message,
        },
      );
  };
  const readCurrent = () => {
    const grant = props.control.clipboardGrant()!;
    const control = props.control;
    const fileDestination = destination();
    const valid = () =>
      current(grant) &&
      props.control === control &&
      destination() === fileDestination;
    busy = true;
    void props
      .clipboard!.readCurrent(props.clientId!, control, {
        files:
          fileDestination === "cache" ||
          fileDestination === "clipboard",
        formats: access.native
          ? undefined
          : access.write
            ? browserClipboardFormats()
            : [],
        receive: async (content, signal) => {
          signal.throwIfAborted();
          if (!valid())
            throw new Error(
              "Control ended or file destination changed",
            );
          if (!content.length || !access.write) return;
          if (!access.native)
            content = await browserClipboardContent(
              content,
              signal,
            );
          signal.throwIfAborted();
          if (!valid()) throw new Error("Control ended");
          try {
            await write(content, grant);
          } catch (error) {
            if (
              !(error instanceof DOMException) ||
              error.name !== "NotAllowedError"
            )
              throw error;
            if (
              pendingPastes.some((paste) => paste.ready())
            )
              throw new DOMException(
                "Superseded by paste",
                "AbortError",
              );
            // Keep the received bytes until a trusted click can write them; no second transfer.
            await new Promise<void>((resolve, reject) => {
              let writing = false;
              let settled = false;
              const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener(
                  "abort",
                  aborted,
                );
                toast.dismiss(id);
                if (pendingCancel === cancel)
                  pendingCancel = undefined;
                error ? reject(error) : resolve();
              };
              const aborted = () => finish(signal.reason);
              const cancel = () =>
                finish(
                  new DOMException(
                    "Cancelled",
                    "AbortError",
                  ),
                );
              const retry = (event?: MouseEvent) => {
                event?.preventDefault();
                if (
                  settled ||
                  writing ||
                  signal.aborted ||
                  !valid()
                )
                  return;
                writing = true;
                void write(content, grant).then(
                  () => finish(),
                  (error) => {
                    writing = false;
                    if (!settled && !signal.aborted)
                      toast.error(
                        t(
                          "remote_control.clipboard_write_failed",
                        ),
                        {
                          description: String(error),
                        },
                      );
                  },
                );
              };
              const id = toast.info(
                t("remote_control.clipboard_ready"),
                {
                  duration: Infinity,
                  action: {
                    label: t(
                      "remote_control.clipboard_write",
                    ),
                    onClick: retry,
                  },
                  cancel: {
                    label: t("common.action.cancel"),
                    onClick: cancel,
                  },
                },
              );
              pendingCancel = cancel;
              signal.addEventListener("abort", aborted, {
                once: true,
              });
              if (signal.aborted) aborted();
            });
          }
        },
      })
      .catch(reportCopyError)
      .finally(startNextOperation);
  };
  let pasteGeneration = 0;
  createEffect(() => {
    if (!enabled()) {
      pasteGeneration++;
      pendingPastes.length = 0;
    }
  });
  const pasteContent = (
    content: Promise<ClipboardContent>,
  ) => {
    const clientId = props.clientId!;
    const control = props.control;
    const grant = control.clipboardGrant();
    const epoch = control.clipboardEpoch();
    const generation = pasteGeneration;
    const valid = () =>
      !!grant &&
      enabled() &&
      generation === pasteGeneration &&
      props.clientId === clientId &&
      props.control === control &&
      control.clipboardGrant() === grant &&
      control.clipboardEpoch() === epoch;
    // Capture the local payload during the gesture and serialize remote writes in gesture order.
    let hasContent = false;
    const prepared = content.then((entries) => {
      hasContent = entries.length > 0;
      if (hasContent && valid()) pendingCancel?.();
      return entries;
    });
    void prepared.catch(() => {});
    pendingPastes.push({
      ready: () => hasContent && valid(),
      run: async () => {
        if (!valid()) return;
        const entries = await prepared;
        if (entries.length && valid())
          await props.clipboard!.paste(
            clientId,
            control,
            entries,
          );
      },
    });
    if (!busy) startNextOperation();
  };
  const pasteEvent = (event: ClipboardEvent): boolean => {
    if (!enabled() || !event.clipboardData) return false;
    event.preventDefault();
    event.stopPropagation();
    pasteContent(
      fromPaste(
        event.clipboardData,
        undefined,
        resolveRemoteFileLimit(
          appState.options.remoteFileMaxSize,
        ),
      ),
    );
    return true;
  };
  createEffect(() => {
    const grant = receiveGrant();
    if (!grant) {
      pendingCancel?.();
      return;
    }
    destination();
    const control = props.control;
    const changed = () => {
      if (
        receiveGrant() === grant &&
        props.control === control &&
        current(grant)
      ) {
        if (busy) queuedChange = changed;
        else readCurrent();
      }
    };
    const stop = props.clipboard!.watch(
      props.clientId!,
      control,
      changed,
    );
    onCleanup(() => {
      if (queuedChange === changed)
        queuedChange = undefined;
      stop();
    });
  });
  return { pasteEvent };
}
