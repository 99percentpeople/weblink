import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { Keyboard, KeyboardOff } from "lucide-solid";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import type {
  RemotePointer,
  PointerState,
} from "@/libs/domain/remote-control/pointer";
import { AutoKeyboard } from "@/libs/domain/remote-control/auto-keyboard";
import { RemoteKeyboard } from "@/libs/domain/remote-control/keyboard";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import { sendRemoteText } from "@/libs/domain/remote-control/text";
import { createRemoteSoftKeyboard } from "@/libs/hooks/remote-soft-keyboard";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { platform } from "@/libs/platform/runtime";
import { MeetingTileAction } from "./meeting-tile-actions";
import { createRemoteClipboard } from "@/libs/hooks/create-remote-clipboard";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import {
  REMOTE_TEXT_CARET,
  REMOTE_TEXT_SEED,
  RemoteTextInput,
} from "@/libs/domain/remote-control/text-input";

export interface RemoteKeyboardInputHandle {
  clipboardEnabled?(action?: "copy" | "paste"): boolean;
  copy?(): void | boolean;
  paste?(): void | boolean;
  pasteEvent?(event: ClipboardEvent): boolean;
  available(): boolean;
  focused(): boolean;
  visible(): boolean;
  suppressAutomaticShow(): void;
  show(): void;
  remoteTap(surface: HTMLElement): void;
}
export type RegisterRemoteKeyboardInput = (
  keyboard: RemoteKeyboardInputHandle,
) => () => void;

/** A real editor focused directly by the user's gesture also works in fullscreen. */
export function RemoteKeyboardInput(props: {
  clientId?: string;
  clipboard?: AppStateContextProps["remoteClipboard"];
  control: RemotePointer;
  state: PointerState;
  enabled: boolean;
  registerKeyboard?: RegisterRemoteKeyboardInput;
}) {
  const clipboard = createRemoteClipboard(props);
  const isMobile = createIsMobile();
  const options = createMemo(() =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ),
  );
  const available = () => {
    // Capabilities are negotiated on the controller, not stored in a signal.
    // Always track state so a late ready/grant makes the keyboard reachable.
    const state = props.state;
    return (
      props.enabled &&
      options().enabled &&
      props.control.supportsText() &&
      (state === "active" || state === "activating")
    );
  };
  const [open, setOpen] = createSignal(false);
  const [visible, setVisible] = createSignal(false);
  const [pageVisible, setPageVisible] = createSignal(true);
  const [editor, setEditor] =
    createSignal<HTMLTextAreaElement>();
  let keys: RemoteKeyboard | undefined;
  let autoKeyboard = new AutoKeyboard();
  let autoSurface: HTMLElement | undefined;
  let automaticChange = false;
  let interactionPending = false;
  const focused = () =>
    !!editor() &&
    editor()!.ownerDocument.activeElement === editor();
  const resetEditor = () => {
    const element = editor();
    if (!element) return;
    element.value = REMOTE_TEXT_SEED;
    element.setSelectionRange(
      REMOTE_TEXT_CARET,
      REMOTE_TEXT_CARET,
    );
  };
  const report = (
    result: ReturnType<typeof sendRemoteText>,
  ) => {
    if (result !== "sent") {
      toast.error(
        t(
          result === "too-long"
            ? "remote_control.text_too_long"
            : "remote_control.text_failed",
        ),
      );
    }
  };
  const input = new RemoteTextInput({
    read: () => editor()?.value ?? REMOTE_TEXT_SEED,
    reset: resetEditor,
    commit: (value) => {
      if (
        !focused() ||
        !available() ||
        props.state !== "active"
      )
        return;
      report(
        sendRemoteText(value, {
          text: (text) =>
            props.control.input({ type: "text", text }),
          key: (code) => keys?.tap(code) ?? false,
        }),
      );
    },
    key: (code) => {
      if (
        focused() &&
        available() &&
        props.state === "active"
      )
        keys?.tap(code);
    },
  });
  const reset = () => {
    input.reset();
    keys?.release();
  };
  const unfocus = () => {
    if (!automaticChange) autoKeyboard.dismiss();
    setOpen(false);
    reset();
    softKeyboard.hide();
  };
  const close = () => {
    unfocus();
    editor()?.blur();
  };
  const softKeyboard = createRemoteSoftKeyboard(
    editor,
    setOpen,
    () => input.hasComposition,
    setVisible,
  );
  createEffect(() => {
    const c = props.control;
    const config = options();
    close();
    const keyboard = new RemoteKeyboard(
      {
        input: (event) => c.input(event),
        cancel: () => {
          close();
          c.resetInput();
        },
      },
      config,
    );
    keys = keyboard;
    onCleanup(() => {
      keyboard.release();
      if (keys === keyboard) keys = undefined;
    });
  });
  createEffect(() => {
    if (!available()) close();
    else if (props.state !== "active") reset();
  });
  createEffect(() => {
    // A gesture-mode change must not carry an unfinished composition.
    appState.options.remoteTouch.mode;
    reset();
  });
  createEffect(() => {
    const element = editor();
    if (!available() || !element) return;
    const doc = element.ownerDocument;
    setPageVisible(!doc.hidden);
    const life = new AbortController();
    doc.addEventListener(
      "selectionchange",
      () => {
        if (focused())
          input.selectionChanged(
            element.selectionStart,
            element.selectionEnd,
          );
      },
      { signal: life.signal },
    );
    doc.addEventListener(
      "visibilitychange",
      () => {
        setPageVisible(!doc.hidden);
        if (doc.hidden) close();
      },
      { signal: life.signal },
    );
    onCleanup(() => life.abort());
  });
  onCleanup(close);
  const openKeyboard = () => {
    if (!available()) return;
    if (!focused()) reset();
    // Explicit actions keep focus synchronous with the gesture. Automatic replies
    // are best-effort: some mobile browsers reject asynchronous keyboard requests.
    softKeyboard.show();
  };
  const show = () => {
    autoKeyboard.manual();
    openKeyboard();
  };
  const automatic = createMemo(
    () =>
      options().autoShow &&
      pageVisible() &&
      available() &&
      platform.kind !== "desktop",
  );
  const remoteTap = (surface: HTMLElement) => {
    const doc = editor()?.ownerDocument;
    if (
      !automatic() ||
      props.state !== "active" ||
      !doc ||
      doc.hidden
    )
      return;
    autoSurface = surface;
    interactionPending = false;
    autoKeyboard.tap();
    props.control.refreshTextInput();
  };
  createEffect(() => {
    const c = props.control;
    const doc = editor()?.ownerDocument;
    if (!doc || !automatic()) return;
    const life = new AbortController();
    const stop = c.watchTextInput((focus) =>
      untrack(() => {
        if (!automatic() || doc.hidden) return;
        const action = autoKeyboard.receive(
          focus,
          !interactionPending &&
            props.state === "active" &&
            autoSurface?.isConnected === true &&
            (doc.activeElement === autoSurface ||
              focused()),
        );
        automaticChange = true;
        try {
          if (action === "show") openKeyboard();
          else if (action === "reset") reset();
          else if (action === "hide") {
            const restoreSurface = focused();
            close();
            if (restoreSurface && autoSurface?.isConnected)
              autoSurface.focus({ preventScroll: true });
          }
        } finally {
          automaticChange = false;
        }
      }),
    );
    const leave = () => {
      autoSurface = undefined;
    };
    doc.addEventListener(
      "pointerdown",
      (event) => {
        interactionPending = true;
        if (
          event.target !== autoSurface &&
          event.target !== editor()
        )
          leave();
      },
      {
        capture: true,
        signal: life.signal,
      },
    );
    doc.addEventListener(
      "focusin",
      (event) => {
        if (
          event.target !== autoSurface &&
          event.target !== editor()
        )
          leave();
      },
      {
        signal: life.signal,
      },
    );
    doc.defaultView?.addEventListener("blur", leave, {
      signal: life.signal,
    });
    onCleanup(() => {
      stop();
      leave();
      autoKeyboard = new AutoKeyboard();
      interactionPending = false;
      life.abort();
    });
  });
  const toggle = () => {
    if (open()) close();
    else show();
  };
  createEffect(() => {
    if (props.registerKeyboard)
      onCleanup(
        props.registerKeyboard({
          clipboardEnabled: (action) =>
            action === "copy"
              ? clipboard.canCopy()
              : clipboard.enabled(),
          copy: clipboard.copy,
          paste: clipboard.paste,
          pasteEvent: clipboard.pasteEvent,
          available,
          visible,
          // IME may already be hidden while its final resize animation runs.
          // A screen tap should then focus the surface, not revive the editor.
          focused: () => open() && focused(),
          suppressAutomaticShow:
            softKeyboard.suppressAutomaticShow,
          show,
          remoteTap,
        }),
      );
  });
  return (
    <Show when={available()}>
      <Show
        when={isMobile() && platform.kind !== "desktop"}
      >
        <MeetingTileAction
          label={t(
            open()
              ? "remote_control.keyboard_hide"
              : "remote_control.keyboard_show",
          )}
          active={open()}
          order={1}
          keepFocus
          onAction={toggle}
        >
          <Show when={open()} fallback={<Keyboard />}>
            <KeyboardOff />
          </Show>
        </MeetingTileAction>
      </Show>
      {/* Keep a focusable editor in the fullscreen surface; never use hidden/display:none. */}
      <textarea
        ref={setEditor}
        rows={1}
        value={REMOTE_TEXT_SEED}
        tabIndex={-1}
        class="pointer-events-none absolute bottom-0 left-0 h-px w-px
          resize-none border-0 p-0 text-base opacity-0 outline-none"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Native IME/window focus changes can leave this editor focused.
          // Only a real DOM focus transfer ends the text-input session.
          if (!focused() && !softKeyboard.restoringFocus())
            unfocus();
        }}
        aria-label={t("remote_control.keyboard_input")}
        inputmode="text"
        enterkeyhint="enter"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
        onBeforeInput={(event) => {
          if (
            input.beforeInput(
              event.inputType,
              event.isComposing,
              event.cancelable,
            )
          )
            event.preventDefault();
        }}
        onInput={(event) =>
          input.input(event.inputType, event.isComposing)
        }
        onCompositionStart={() => input.compositionStart()}
        onCompositionEnd={() => input.compositionEnd()}
        onPaste={(event) => {
          if (clipboard.pasteEvent(event)) {
            resetEditor();
            return;
          }
          event.preventDefault();
          input.paste(
            event.clipboardData?.getData("text/plain") ??
              "",
          );
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            !focused() ||
            !available() ||
            props.state !== "active"
          )
            return;
          if (
            input.hasComposition ||
            event.isComposing ||
            event.key === "Process"
          )
            return;
          const shortcut =
            event.ctrlKey || event.altKey || event.metaKey;
          if (
            clipboard.enabled() &&
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey
          ) {
            if (event.code === "KeyV") return;
            if (
              event.code === "KeyC" &&
              clipboard.canCopy()
            ) {
              event.preventDefault();
              if (!event.repeat) clipboard.copy();
              return;
            }
          }
          // Software keyboards need not report a physical key position.
          const code =
            event.code && event.code !== "Unidentified"
              ? event.code
              : event.key;
          if (
            (shortcut &&
              !/^(Control|Alt|Shift|Meta)/.test(code)) ||
            [
              "Escape",
              "Tab",
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(code)
          ) {
            event.preventDefault();
            keys?.tap(code, [
              ...(event.ctrlKey ? ["ControlLeft"] : []),
              ...(event.altKey ? ["AltLeft"] : []),
              ...(event.shiftKey ? ["ShiftLeft"] : []),
              ...(event.metaKey ? ["MetaLeft"] : []),
            ]);
          }
        }}
        onKeyUp={(event) => event.stopPropagation()}
      />
    </Show>
  );
}
