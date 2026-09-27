import { createSignal, onCleanup } from "solid-js";

const changed = "weblink:conversation-draft";

/** Session-local drafts also stay coherent when acceptance outlives a mounted view. */
export function createConversationDraft(
  conversationId: string,
) {
  const key = `conversation-draft:${conversationId}`;
  const read = (): string => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem(key) ?? '""',
      );
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  const [value, setValue] = createSignal(read());
  const controller = new AbortController();
  window.addEventListener(
    changed,
    (event) => {
      const detail = (
        event as CustomEvent<{ key: string; value: string }>
      ).detail;
      if (detail?.key === key) setValue(detail.value);
    },
    { signal: controller.signal },
  );
  onCleanup(() => controller.abort());
  const update = (text: string) => {
    setValue(text);
    try {
      sessionStorage.setItem(key, JSON.stringify(text));
    } catch {
      /* Keep the live draft usable if session storage is unavailable. */
    }
    window.dispatchEvent(
      new CustomEvent(changed, {
        detail: { key, value: text },
      }),
    );
  };
  return {
    value,
    update,
    accepted(snapshot: string) {
      if (value() === snapshot && read() === snapshot)
        update("");
    },
  };
}
