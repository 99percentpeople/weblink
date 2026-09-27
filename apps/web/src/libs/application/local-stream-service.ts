import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

export interface LocalStreamService {
  readonly stream: Accessor<MediaStream | null>;
  replace(stream: MediaStream | null): void;
  clear(): void;
  dispose(): void;
}

export const createLocalStreamService =
  (): LocalStreamService => {
    const [stream, setStream] =
      createSignal<MediaStream | null>(null);
    let listenerController: AbortController | undefined;

    const releaseListeners = () => {
      listenerController?.abort();
      listenerController = undefined;
    };

    const refresh = (target: MediaStream) => {
      if (stream() !== target) return;
      const tracks = target
        .getTracks()
        .filter((track) => track.readyState !== "ended");
      // Native removeTrack does not dispatch an event. A fresh wrapper makes
      // track membership observable to Solid and the session sender effect.
      replace(
        tracks.length ? new MediaStream(tracks) : null,
      );
    };

    const listen = (target: MediaStream) => {
      const controller = new AbortController();
      listenerController = controller;
      target.getTracks().forEach((track) => {
        track.addEventListener(
          "ended",
          () => {
            if (stream() !== target) return;
            target.removeTrack(track);
            refresh(target);
          },
          { once: true, signal: controller.signal },
        );
      });
      target.addEventListener(
        "addtrack",
        () => refresh(target),
        { signal: controller.signal },
      );
      target.addEventListener(
        "removetrack",
        () => refresh(target),
        { signal: controller.signal },
      );
    };

    const replace = (next: MediaStream | null) => {
      const current = stream();
      if (current === next) return;
      releaseListeners();
      const retained = new Set(next?.getTracks() ?? []);
      current?.getTracks().forEach((track) => {
        if (retained.has(track)) return;
        current.removeTrack(track);
        track.stop();
      });
      const published = next?.getTracks().length
        ? next
        : null;
      // Install listeners before notifying reactive consumers. They may replace
      // the stream synchronously while reacting to this publication.
      if (published) listen(published);
      setStream(published);
    };

    const clear = () => replace(null);
    const dispose = () => replace(null);

    return { stream, replace, clear, dispose };
  };
