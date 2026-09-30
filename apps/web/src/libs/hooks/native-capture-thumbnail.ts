import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import type {
  CaptureBackend,
  NativeCapture,
} from "@weblink/platform";

interface ThumbnailRequest {
  sourceId: string;
  backend: CaptureBackend;
  revision: number;
}

/** At most one native request in flight, plus the most recent pending selection. */
export function createCaptureThumbnail(
  capture: NativeCapture,
  selection: Accessor<ThumbnailRequest | null>,
) {
  const [url, setUrl] = createSignal<string>();
  const [state, setState] = createSignal<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const selected = createMemo(selection, null, {
    equals: (a, b) =>
      a?.sourceId === b?.sourceId &&
      a?.backend === b?.backend &&
      a?.revision === b?.revision,
  });
  let generation = 0;
  let disposed = false;
  let running = false;
  let pending:
    | (ThumbnailRequest & { generation: number })
    | undefined;
  const clearImage = () => {
    const image = untrack(url);
    if (image) URL.revokeObjectURL(image);
    setUrl(undefined);
  };
  const load = async () => {
    if (running) return;
    running = true;
    try {
      while (!disposed && pending) {
        const request = pending;
        pending = undefined;
        try {
          const image = await capture.thumbnail(
            request.sourceId,
            { backend: request.backend },
          );
          if (
            !disposed &&
            request.generation === generation
          ) {
            setUrl(URL.createObjectURL(image));
            setState("ready");
          }
        } catch {
          if (
            !disposed &&
            request.generation === generation
          )
            setState("failed");
        }
      }
    } finally {
      running = false;
    }
  };
  createEffect(() => {
    const request = selected();
    generation++;
    clearImage();
    pending = request
      ? { ...request, generation }
      : undefined;
    setState(request ? "loading" : "idle");
    void load();
  });
  onCleanup(() => {
    disposed = true;
    generation++;
    pending = undefined;
    clearImage();
  });
  return { url, state };
}
