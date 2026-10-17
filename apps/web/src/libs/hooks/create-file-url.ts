import type { StoredFile } from "@weblink/platform";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";

/** Own a preview URL, including asynchronous reads and late completion cleanup. */
export function createFileUrl(
  source: Accessor<StoredFile | null | undefined>,
) {
  const file = createMemo(source);
  const [url, setUrl] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<Error>();

  createEffect(() => {
    const current = file();
    setUrl(undefined);
    setError(undefined);
    setLoading(!!current);
    if (!current) return;
    const controller = new AbortController();
    let ownedUrl: string | undefined;
    onCleanup(() => {
      controller.abort();
      if (ownedUrl) revokeFileUrl(ownedUrl);
    });
    const ready = (value: string) => {
      if (controller.signal.aborted) {
        revokeFileUrl(value);
        return;
      }
      ownedUrl = value;
      setUrl(value);
      setLoading(false);
    };
    const failed = (reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error
          ? reason
          : new Error(String(reason)),
      );
      setLoading(false);
    };
    try {
      const result = fileObjectUrl(
        current,
        controller.signal,
      );
      if (typeof result === "string") ready(result);
      else void result.then(ready, failed);
    } catch (reason) {
      failed(reason);
    }
  });

  return { url, loading, error };
}
