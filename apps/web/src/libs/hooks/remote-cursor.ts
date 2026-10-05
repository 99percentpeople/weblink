import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import type { RemoteCursorShape } from "../domain/protocol/remote-control/cursor";
import type { RemotePointer } from "../domain/remote-control/pointer";

/** Local mouse mode only. Captured/relative input continues to use the video cursor. */
export function createRemoteCursor(
  control: Accessor<RemotePointer | undefined>,
  enabled: Accessor<boolean>,
  synchronize: Accessor<boolean> = () => true,
): Accessor<string | undefined> {
  const [cursor, setCursor] = createSignal<string>();
  // A drag moving back inside changes hover state without ending cursor ownership.
  const target = createMemo(() =>
    enabled() ? control() : undefined,
  );
  const sync = createMemo(synchronize);
  createEffect(() => {
    const c = target();
    if (!c) return;
    let pending: HTMLImageElement | undefined;
    const clearImage = () => {
      if (pending) pending.onload = pending.onerror = null;
      pending = undefined;
    };
    const show = (style: string, local: boolean) => {
      setCursor(style);
      c.setCursorVisible(!local);
    };
    const apply = (
      shape: RemoteCursorShape | undefined,
    ) => {
      clearImage();
      if (!shape) return show("default", true);
      if (shape.type === "system")
        return show(shape.name, true);
      show("none", false);
      if (shape.type !== "image") return;
      const image = new Image();
      pending = image;
      const url = `data:image/png;base64,${shape.png}`;
      image.onload = () => {
        if (pending !== image) return;
        clearImage();
        if (
          image.naturalWidth === shape.width &&
          image.naturalHeight === shape.height
        )
          show(
            `url("${url}") ${shape.hotspotX} ${shape.hotspotY}, default`,
            true,
          );
      };
      image.onerror = () => {
        if (pending === image) clearImage();
      };
      image.src = url;
    };
    let stop = () => {};
    if (sync()) stop = c.watchCursor(apply);
    else apply(undefined);
    onCleanup(() => {
      stop();
      clearImage();
      setCursor(undefined);
      c.setCursorVisible(true);
    });
  });
  return cursor;
}
