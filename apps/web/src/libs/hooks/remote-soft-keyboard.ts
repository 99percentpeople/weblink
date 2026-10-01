interface VirtualKeyboardAPI extends EventTarget {
  show(): void;
  hide(): void;
  readonly boundingRect: { height: number };
}

/** Scoped to one editor; never changes fullscreen or the page's viewport policy. */
export function createRemoteSoftKeyboard(
  readEditor: () => HTMLTextAreaElement | undefined,
  onVisibilityChange: (visible: boolean) => void,
) {
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
    /** Must run directly inside the keyboard button's click, without awaiting. */
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
      const policy = editor.getAttribute(
        "virtualkeyboardpolicy",
      );
      const manual =
        typeof api?.show === "function" &&
        typeof api.hide === "function";
      let wasVisible = false;
      const geometry = () => {
        const visible = api!.boundingRect.height > 0;
        const changed = wasVisible !== visible;
        wasVisible = visible;
        // Geometry is an observation, never a reason to blur the editor or call
        // hide(). Fullscreen/IME transitions can briefly report a zero rect.
        if (changed && doc.activeElement === editor)
          onVisibilityChange(visible);
      };
      if (manual) {
        editor.setAttribute(
          "virtualkeyboardpolicy",
          "manual",
        );
        api.addEventListener("geometrychange", geometry);
      }
      const show = () => {
        onVisibilityChange(true);
        if (!manual) return;
        try {
          api.show();
        } catch {
          release();
          editor.blur();
          editor.focus({ preventScroll: true });
          session = {
            editor,
            show: () => {
              editor.focus({ preventScroll: true });
              onVisibilityChange(true);
            },
            release() {},
          };
        }
      };
      session = {
        editor,
        show,
        release() {
          if (!manual) return;
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
          if (policy === null)
            editor.removeAttribute("virtualkeyboardpolicy");
          else
            editor.setAttribute(
              "virtualkeyboardpolicy",
              policy,
            );
        },
      };
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
