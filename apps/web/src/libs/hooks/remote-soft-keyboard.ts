interface VirtualKeyboardAPI extends EventTarget {
  show(): void;
  hide(): void;
  readonly boundingRect: { height: number };
}

/** Scoped to one editor; never changes fullscreen or the page's viewport policy. */
export function createRemoteSoftKeyboard(
  readEditor: () => HTMLTextAreaElement | undefined,
  onVisibilityChange: (visible: boolean) => void,
  hasComposition: () => boolean = () => false,
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
      const manual =
        typeof api?.show === "function" &&
        typeof api.hide === "function";
      const refocus = () => {
        if (
          hasComposition() ||
          doc.activeElement !== editor
        )
          return;
        // On HTTP there is no virtualKeyboard.show(). After Android Back, an
        // already focused editor needs a new focus transition to request IME.
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
        if (changed && doc.activeElement === editor)
          onVisibilityChange(visible);
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
      const releaseObservers = () => {
        cancelDismiss();
        viewport?.removeEventListener("resize", resized);
      };
      if (manual) {
        editor.setAttribute(
          "virtualkeyboardpolicy",
          "manual",
        );
        api.addEventListener("geometrychange", geometry);
      }
      const show = (repeat = false) => {
        cancelDismiss();
        viewportDismissed = false;
        onVisibilityChange(true);
        if (!manual) {
          // Only an explicit keyboard action enables the automatic IME path.
          editor.setAttribute(
            "virtualkeyboardpolicy",
            "auto",
          );
          if (repeat) refocus();
          return;
        }
        try {
          api.show();
        } catch {
          release();
          editor.blur();
          editor.focus({ preventScroll: true });
          session = {
            editor,
            show: () => {
              cancelDismiss();
              editor.setAttribute(
                "virtualkeyboardpolicy",
                "auto",
              );
              refocus();
              onVisibilityChange(true);
            },
            release: () => {
              releaseObservers();
              restorePolicy();
            },
          };
          viewport?.addEventListener("resize", resized);
        }
      };
      session = {
        editor,
        show: () => show(true),
        release() {
          releaseObservers();
          if (!manual) {
            restorePolicy();
            return;
          }
          api.removeEventListener(
            "geometrychange",
            geometry,
          );
          // Hide while manual policy and focus still belong to this editor.
          if (doc.activeElement === editor) {
            try {
              api.hide();
            } catch {
              /* Focus/blur still works. */
            }
          }
          restorePolicy();
        },
      };
      if (!manual)
        editor.setAttribute(
          "virtualkeyboardpolicy",
          "auto",
        );
      editor.focus({ preventScroll: true });
      if (doc.activeElement !== editor) {
        release();
        return;
      }
      show();
    },
    hide,
  };
}
