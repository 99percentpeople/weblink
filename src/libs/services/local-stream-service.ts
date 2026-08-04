import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";
import { stopMediaStream } from "@/libs/core/media-stream";

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

    const clearIfEmpty = (target: MediaStream) => {
      if (stream() !== target) return;
      if (target.getTracks().length !== 0) return;

      releaseListeners();
      setStream(null);
    };

    const listen = (target: MediaStream) => {
      const controller = new AbortController();
      const observedTracks =
        new WeakSet<MediaStreamTrack>();
      listenerController = controller;

      const observeTrack = (track: MediaStreamTrack) => {
        if (observedTracks.has(track)) return;
        observedTracks.add(track);

        track.addEventListener(
          "ended",
          () => {
            if (stream() !== target) return;
            target.removeTrack(track);
            clearIfEmpty(target);
          },
          {
            once: true,
            signal: controller.signal,
          },
        );
      };

      target.getTracks().forEach(observeTrack);
      target.addEventListener(
        "addtrack",
        (event) => observeTrack(event.track),
        { signal: controller.signal },
      );
      target.addEventListener(
        "removetrack",
        () => clearIfEmpty(target),
        { signal: controller.signal },
      );

      clearIfEmpty(target);
    };

    const replace = (next: MediaStream | null) => {
      const current = stream();
      if (current === next) return;

      releaseListeners();
      stopMediaStream(current);
      setStream(next);

      if (next) listen(next);
    };

    const clear = () => replace(null);
    const dispose = () => replace(null);

    return {
      stream,
      replace,
      clear,
      dispose,
    };
  };

export const localStreamService =
  createLocalStreamService();

export const localStream = localStreamService.stream;

export const replaceLocalStream = (
  stream: MediaStream | null,
): void => {
  localStreamService.replace(stream);
};

export const clearLocalStream = (): void => {
  localStreamService.clear();
};
