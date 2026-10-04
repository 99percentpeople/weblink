interface VirtualKeyboardAPI extends EventTarget {
  readonly boundingRect: { height: number };
}

/** Scoped to one editor; never changes fullscreen or the page's viewport policy. */
export function createRemoteSoftKeyboard(
  readEditor: () => HTMLTextAreaElement | undefined,
  onVisibilityChange: (visible: boolean) => void,
  hasComposition: () => boolean = () => false,
  onObservedVisibilityChange: (
    visible: boolean,
  ) => void = () => {},
) {
  let refocusing = false;
  let session:
    | {
        editor: HTMLTextAreaElement;
        show(): void;
        release(): void;
      }
    | undefined;

  const release = () => {
    const current = session;
    session = undefined;
    current?.release();
    onObservedVisibilityChange(false);
  };
  const hide = () => {
    const current = session;
    release();
    if (
      !current ||
      current.editor.ownerDocument.activeElement !==
        current.editor
    )
      return;
    current.editor.blur();
  };
  return {
    restoringFocus: () => refocusing,
    /** Keep the current IME state while operating the remote screen. Chromium
     * honors this HTML policy even on HTTP, where the JS API is unavailable.
     * In particular, a floating IME dismissed with Back need not emit a resize.
     */
    suppressAutomaticShow() {
      const editor = session?.editor;
      if (editor?.ownerDocument.activeElement === editor)
        editor?.setAttribute(
          "virtualkeyboardpolicy",
          "manual",
        );
    },
    /** Run synchronously in the explicit keyboard action, without awaiting. */
    show() {
      const editor = readEditor();
      if (!editor?.isConnected) return;
      const doc = editor.ownerDocument;
      if (
        session?.editor === editor &&
        doc.activeElement === editor
      ) {
        session.show();
        return;
      }
      release();
      const nav = doc.defaultView?.navigator as
        | (Navigator & {
            virtualKeyboard?: VirtualKeyboardAPI;
          })
        | undefined;
      const api = nav?.virtualKeyboard;
      const view = doc.defaultView;
      const viewport = view?.visualViewport;
      const policy = editor.getAttribute(
        "virtualkeyboardpolicy",
      );
      const restorePolicy = () => {
        if (policy === null)
          editor.removeAttribute("virtualkeyboardpolicy");
        else
          editor.setAttribute(
            "virtualkeyboardpolicy",
            policy,
          );
      };
      const refocus = () => {
        if (
          hasComposition() ||
          doc.activeElement !== editor
        )
          return;
        // After Android Back, an already focused editor needs a new focus
        // transition to request IME. Use the same path on HTTP and HTTPS.
        // The UI must keep its input session alive through this synchronous blur.
        refocusing = true;
        try {
          editor.blur();
          editor.focus({ preventScroll: true });
        } finally {
          refocusing = false;
        }
      };
      let wasVisible = false;
      let observedVisible = false;
      let viewportObservedVisible = false;
      let viewportDismissed = false;
      let dismissTimer:
        | ReturnType<typeof setTimeout>
        | undefined;
      let viewportWidth = viewport?.width ?? 0;
      let viewportScale = viewport?.scale ?? 1;
      let viewportHeight = Math.max(
        viewport?.height ?? 0,
        (view?.innerHeight ?? 0) / viewportScale,
      );
      const cancelDismiss = () => {
        clearTimeout(dismissTimer);
        dismissTimer = undefined;
      };
      const viewportVisible = (): boolean | undefined => {
        if (!viewport || !viewport.height) return;
        // Rotation and zoom change the viewport independently of IME visibility.
        if (
          Math.abs(viewport.width - viewportWidth) > 1 ||
          Math.abs(viewport.scale - viewportScale) > 0.01
        ) {
          viewportWidth = viewport.width;
          viewportScale = viewport.scale;
          viewportHeight = Math.max(
            viewport.height,
            (view?.innerHeight ?? 0) / viewportScale,
          );
          cancelDismiss();
          return;
        }
        viewportHeight = Math.max(
          viewportHeight,
          viewport.height,
        );
        return (
          viewportHeight - viewport.height >
          Math.max(80, viewportHeight * 0.15)
        );
      };
      const observe = (visible: boolean) => {
        const changed = wasVisible !== visible;
        wasVisible = visible;
        if (visible) {
          observedVisible = true;
          cancelDismiss();
        } else if (
          observedVisible &&
          dismissTimer === undefined
        ) {
          // Android Back can hide IME without blurring. Allow animation gaps,
          // then release focus so the next screen tap cannot reopen the keyboard.
          dismissTimer = setTimeout(() => {
            dismissTimer = undefined;
            if (
              session?.editor !== editor ||
              doc.activeElement !== editor ||
              (!viewportDismissed &&
                (api?.boundingRect.height ?? 0) > 0) ||
              viewportVisible() === true
            )
              return;
            hide();
            onVisibilityChange(false);
          }, 180);
        }
        // A temporary zero rectangle must not tear down the editor or discard
        // a pending IME commit. Publish dismissal only after the timer verifies it.
        if (
          changed &&
          visible &&
          doc.activeElement === editor
        ) {
          onVisibilityChange(true);
          onObservedVisibilityChange(true);
        }
      };
      const geometry = () => {
        if (api!.boundingRect.height > 0)
          viewportDismissed = false;
        observe(
          api!.boundingRect.height > 0 ||
            viewportVisible() === true,
        );
      };
      const resized = () => {
        const visible = viewportVisible();
        if (visible === undefined) return;
        if (visible) {
          viewportObservedVisible = true;
          viewportDismissed = false;
        } else if (viewportObservedVisible) {
          // Fullscreen Chrome can leave boundingRect stale after Android Back.
          viewportDismissed = true;
        }
        observe(
          visible ||
            (!viewportDismissed &&
              (api?.boundingRect.height ?? 0) > 0),
        );
      };
      viewport?.addEventListener("resize", resized);
      api?.addEventListener("geometrychange", geometry);
      const show = (repeat = false) => {
        cancelDismiss();
        viewportDismissed = false;
        onVisibilityChange(true);
        // Keep native IME focus/commit behavior identical in secure and insecure
        // contexts. The optional API only observes visibility, never drives IME.
        editor.setAttribute(
          "virtualkeyboardpolicy",
          "auto",
        );
        if (repeat) refocus();
      };
      session = {
        editor,
        show: () => show(true),
        release() {
          cancelDismiss();
          viewport?.removeEventListener("resize", resized);
          api?.removeEventListener(
            "geometrychange",
            geometry,
          );
          restorePolicy();
        },
      };
      editor.setAttribute("virtualkeyboardpolicy", "auto");
      editor.focus({ preventScroll: true });
      if (doc.activeElement !== editor) {
        release();
        return;
      }
      show();
      // Some browsers report geometry synchronously during focus.
      if (api) geometry();
      else resized();
    },
    hide,
  };
}
