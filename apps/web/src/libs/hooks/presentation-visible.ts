import {
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import { platform } from "@/libs/platform/runtime";

/** Presentation only: visibility must never own media, connection or lease lifetimes. */
export function createPresentationVisible(
  document: Accessor<Document | undefined> = () =>
    globalThis.document,
): Accessor<boolean> {
  const [nativeVisible, setNativeVisible] =
    createSignal(true);
  const [documentVisible, setDocumentVisible] =
    createSignal(!document()?.hidden);
  const unwatch = platform.watchVisibility?.(
    setNativeVisible,
  );
  onCleanup(() => unwatch?.());
  createEffect(() => {
    const owner = document();
    const update = () => setDocumentVisible(!owner?.hidden);
    update();
    owner?.addEventListener("visibilitychange", update);
    onCleanup(() =>
      owner?.removeEventListener(
        "visibilitychange",
        update,
      ),
    );
  });
  return () => nativeVisible() && documentVisible();
}
