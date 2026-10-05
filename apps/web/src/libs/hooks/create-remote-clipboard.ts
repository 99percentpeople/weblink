import {
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { platform } from "@/libs/platform/runtime";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import type {
  PointerState,
  RemotePointer,
} from "@/libs/domain/remote-control/pointer";
import {
  fromNativeClipboard,
  fromBrowserPaste,
  beginBrowserClipboardWrite,
  readBrowserClipboard,
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
  let disposed = false;
  onCleanup(() => {
    disposed = true;
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
  const canCopy = () =>
    enabled() &&
    access.ready &&
    (access.write || destination() === "cache");
  const [busy, setBusy] = createSignal(false);
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
      await platform.clipboard!.write(entries);
    } else await writeBrowserClipboard(content);
  };
  const copy = (selection = true): boolean => {
    if (!canCopy()) return false;
    if (busy()) return true;
    const grant = props.control.clipboardGrant()!;
    const control = props.control;
    const fileDestination = destination();
    const valid = () =>
      current(grant) &&
      props.control === control &&
      destination() === fileDestination;
    setBusy(true);
    let resolve!: (content: ClipboardContent) => void;
    let reject!: (error: unknown) => void;
    const received = new Promise<ClipboardContent>(
      (yes, no) => {
        resolve = yes;
        reject = no;
      },
    );
    void received.catch(() => {});
    const reserved =
      selection && access.write && !access.native
        ? beginBrowserClipboardWrite(
            received,
            fileDestination === "clipboard",
          )
        : undefined;
    void reserved?.catch(() => {});
    void props
      .clipboard!.copy(
        props.clientId!,
        control,
        selection,
        {
          files:
            fileDestination === "cache" ||
            (fileDestination === "clipboard" &&
              access.writeFiles),
          receive: async (content, signal) => {
            signal.throwIfAborted();
            if (!valid())
              throw new Error(
                "Control ended or file destination changed",
              );
            if (!content.length || !access.write) {
              reject(
                new Error("No local clipboard content"),
              );
              await reserved?.catch(() => {});
              return;
            }
            resolve(content);
            let written = false;
            if (reserved) {
              try {
                await reserved;
                written = true;
              } catch (error) {
                if (
                  error instanceof DOMException &&
                  error.name === "NotAllowedError"
                )
                  throw error;
              }
            }
            signal.throwIfAborted();
            if (!valid())
              throw new Error(
                "Control ended or file destination changed",
              );
            if (
              !written ||
              content.some(
                (entry) =>
                  entry.type !== "text/plain" &&
                  entry.type !== "file",
              )
            ) {
              // Keep the successfully reserved binary bundle if a richer native format is rejected.
              try {
                await write(content, grant);
              } catch (error) {
                if (!written) throw error;
              }
            }
          },
        },
      )
      .catch((error) => reject(error))
      .finally(() => setBusy(false));
    return true;
  };
  const pasteContent = (
    content: Promise<ClipboardContent>,
  ) => {
    if (!enabled() || busy()) {
      void content.catch(() => {});
      return;
    }
    setBusy(true);
    void props
      .clipboard!.paste(
        props.clientId!,
        props.control,
        content,
      )
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const paste = (): boolean => {
    if (!enabled() || !access.read) return false;
    if (busy()) return true;
    // A denied programmatic read never prevents a real paste event.
    const content = access.native
      ? platform
          .clipboard!.read()
          .then((s) => fromNativeClipboard(s.entries))
      : readBrowserClipboard();
    pasteContent(content);
    return true;
  };
  const pasteEvent = (event: ClipboardEvent): boolean => {
    if (!enabled() || !event.clipboardData) return false;
    event.preventDefault();
    event.stopPropagation();
    pasteContent(
      fromBrowserPaste(event.clipboardData, access.read),
    );
    return true;
  };
  createEffect(() => {
    if (!canCopy()) return;
    destination();
    const control = props.control;
    const grant = control.clipboardGrant()!;
    onCleanup(
      props.clipboard!.watch(
        props.clientId!,
        control,
        () => {
          if (
            !canCopy() ||
            busy() ||
            props.control !== control ||
            control.clipboardGrant() !== grant
          )
            return;
          copy(false);
        },
      ),
    );
  });
  return {
    enabled,
    canCopy,
    copy,
    paste,
    pasteEvent,
  };
}
