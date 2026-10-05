import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import type { RuntimeCapabilities } from "@weblink/platform";
import {
  browserClipboardAccess,
  supportsBrowserClipboardFiles,
} from "@/libs/application/clipboard-content";
import { appState, setAppState } from "./app-state";

/** AppState owns clipboard discovery and permission listeners for all views. */
export function createAppClipboardAccess(options: {
  nativeClipboard: boolean;
  runtimeCapabilities: Accessor<
    RuntimeCapabilities | undefined
  >;
  runtimeReady(): Promise<void>;
}): void {
  const browser = browserClipboardAccess();
  const files = supportsBrowserClipboardFiles();
  const [runtimeReady, setRuntimeReady] =
    createSignal(false);
  const [permissionsReady, setPermissionsReady] =
    createSignal(false);
  const life = new AbortController();
  onCleanup(() => life.abort());

  createEffect(() => {
    const ready = runtimeReady() && permissionsReady();
    const native =
      options.nativeClipboard &&
      options.runtimeCapabilities()?.nativeClipboard ===
        true;
    const access = appState.capabilities.clipboard;
    const read =
      ready &&
      (native ||
        (browser.read &&
          access.readPermission !== "denied"));
    const write =
      ready &&
      (native ||
        (browser.write &&
          access.writePermission !== "denied"));
    const writeFiles =
      ready &&
      (native ||
        (files && access.writePermission !== "denied"));
    setAppState("capabilities", "clipboard", {
      ready,
      native,
      read,
      write,
      writeFiles,
    });
    // Persist the first resolved default once. Later permission changes never replace a choice.
    if (
      ready &&
      appState.options.remoteKeyboard.clipboardFiles ===
        undefined
    )
      setAppState(
        "options",
        "remoteKeyboard",
        "clipboardFiles",
        writeFiles ? "clipboard" : "cache",
      );
  });

  onMount(() => {
    void options
      .runtimeReady()
      .catch(() => {})
      .then(() => {
        if (!life.signal.aborted) setRuntimeReady(true);
      });
    const observe = async (
      name: "clipboard-read" | "clipboard-write",
    ) => {
      try {
        const permission =
          await navigator.permissions?.query({
            name: name as PermissionName,
          });
        if (!permission || life.signal.aborted) return;
        const changed = () =>
          setAppState(
            "capabilities",
            "clipboard",
            name === "clipboard-read"
              ? "readPermission"
              : "writePermission",
            permission.state,
          );
        changed();
        permission.addEventListener("change", changed, {
          signal: life.signal,
        });
      } catch {
        // Unsupported permission queries leave API availability usable during real gestures.
      }
    };
    void Promise.all([
      observe("clipboard-read"),
      observe("clipboard-write"),
    ]).then(() => {
      if (!life.signal.aborted) setPermissionsReady(true);
    });
  });
}
