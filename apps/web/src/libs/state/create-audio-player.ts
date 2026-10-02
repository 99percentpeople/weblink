import { appState } from "@/libs/state/app-state";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  getRemoteAudioVideoTrackId,
  meetingAudioSourceId,
} from "@/routes/home/components/meeting-audio-sources";

import type { AudioPlayerContextValue } from "./audio-player-context";

export interface AudioPlayerController {
  readonly value: AudioPlayerContextValue;
  attach(element: HTMLAudioElement): void;
  detach(element: HTMLAudioElement): void;
  onPlaying(element: HTMLAudioElement): void;
  onPause(element: HTMLAudioElement): void;
}
export function createAudioPlayer(): AudioPlayerController {
  const [tracks, setTracks] = createSignal<
    MediaStreamTrack[]
  >([]);
  const [peerTracks, setPeerTracks] = createSignal(
    new Map<string, MediaStreamTrack[]>(),
  );
  const [mutedPeers, setMutedPeers] = createSignal(
    new Set<string>(),
  );
  const [sourceMutes, setSourceMutes] = createSignal(
    new Map<string, { peerId: string; muted: boolean }>(),
  );
  const audioSourceId = (
    peerId: string,
    track: MediaStreamTrack,
  ) =>
    meetingAudioSourceId(
      peerId,
      getRemoteAudioVideoTrackId(
        track.id,
        appState.session.clientViewData[peerId] ?? {},
      ),
    );
  const isSourceMuted = (
    peerId: string,
    sourceId: string,
  ) =>
    sourceMutes().get(sourceId)?.muted ??
    mutedPeers().has(peerId);
  const setSourceMuted = (
    peerId: string,
    sourceId: string,
    muted: boolean,
  ) => {
    setSourceMutes((previous) =>
      new Map(previous).set(sourceId, { peerId, muted }),
    );
  };
  const isPeerMuted = (id: string) => {
    const current = peerTracks().get(id);
    return current?.length
      ? current.every((track) =>
          isSourceMuted(id, audioSourceId(id, track)),
        )
      : mutedPeers().has(id);
  };
  const setPeerMuted = (id: string, muted: boolean) => {
    batch(() => {
      setMutedPeers((previous) => {
        const next = new Set(previous);
        if (muted) next.add(id);
        else next.delete(id);
        return next;
      });
      // The member action applies to all sources, including ones added later.
      setSourceMutes(
        (previous) =>
          new Map(
            [...previous].filter(
              ([, value]) => value.peerId !== id,
            ),
          ),
      );
    });
  };
  const [wantsAudio, setWantsAudio] = createSignal(true);
  const [playState, setPlayState] = createSignal(false);
  const [audioRef, setAudioRef] =
    createSignal<HTMLAudioElement>();
  const [outputDeviceId, setOutputDeviceId] =
    createSignal("");
  const [outputBusy, setOutputBusy] = createSignal(false);
  const outputSupported = createMemo(
    () => typeof audioRef()?.setSinkId === "function",
  );
  let outputQueue: Promise<void> = Promise.resolve();
  let pendingOutputRequests = 0;
  let disposed = false;
  let playbackVersion = 0;

  const outputAborted = () =>
    new DOMException(
      "Audio player was disposed",
      "AbortError",
    );
  const setOutputDevice = (id: string): Promise<void> => {
    if (disposed) return Promise.reject(outputAborted());
    ++pendingOutputRequests;
    setOutputBusy(true);
    // Serialize native calls so a slow earlier device cannot overwrite the
    // browser's actual sink after a newer request has already succeeded.
    const operation = outputQueue.then(async () => {
      if (disposed) throw outputAborted();
      const audio = audioRef();
      if (!audio)
        throw new DOMException(
          "Audio player is not ready",
          "InvalidStateError",
        );
      if (typeof audio.setSinkId !== "function") {
        if (id !== "")
          throw new DOMException(
            "Audio output selection is unavailable",
            "NotSupportedError",
          );
      } else {
        await audio.setSinkId(id);
      }
      if (disposed || audioRef() !== audio)
        throw outputAborted();
      setOutputDeviceId(id);
    });
    // One denied/missing device must not poison the following selection.
    outputQueue = operation.catch(() => {});
    return operation.finally(() => {
      if (disposed) return;
      --pendingOutputRequests;
      setOutputBusy(pendingOutputRequests > 0);
    });
  };

  createEffect(() => {
    const peers = Object.values(
      appState.session.clientViewData,
    )
      .filter(Boolean)
      .map((client) => ({
        id: client.clientId,
        streams: [
          client.stream,
          client.nativeScreenStream,
        ].filter(
          (stream): stream is MediaStream => !!stream,
        ),
      }));
    const controller = new AbortController();
    const observed = new WeakSet<MediaStreamTrack>();
    const refresh = () => {
      const byPeer = new Map(
        peers.map(({ id, streams }) => [
          id,
          streams
            .flatMap((stream) => stream.getAudioTracks())
            .filter(
              (track) => track.readyState !== "ended",
            ),
        ]),
      );
      setPeerTracks(byPeer);
      const next = [
        ...new Set([...byPeer.values()].flat()),
      ];
      next.forEach((track) => {
        if (observed.has(track)) return;
        observed.add(track);
        track.addEventListener("ended", refresh, {
          signal: controller.signal,
        });
      });
      setTracks((previous) =>
        previous.length === next.length &&
        previous.every(
          (track, index) => track === next[index],
        )
          ? previous
          : next,
      );
    };
    peers
      .flatMap(({ streams }) => streams)
      .forEach((stream) => {
        stream.addEventListener("addtrack", refresh, {
          signal: controller.signal,
        });
        stream.addEventListener("removetrack", refresh, {
          signal: controller.signal,
        });
      });
    refresh();
    onCleanup(() => controller.abort());
  });

  createEffect(() => {
    for (const [id, tracks] of peerTracks()) {
      // Received tracks only: this never changes the sender's capture state.
      for (const track of tracks)
        track.enabled = !isSourceMuted(
          id,
          audioSourceId(id, track),
        );
    }
  });

  const audioStream = createMemo(() =>
    tracks().length ? new MediaStream(tracks()) : null,
  );
  createEffect(() => {
    const audio = audioRef();
    const stream = audioStream();
    const wanted = wantsAudio();
    const version = ++playbackVersion;
    if (!audio) return;
    if (audio.srcObject !== stream)
      audio.srcObject = stream;
    if (!stream || !wanted) {
      audio.pause();
      setPlayState(false);
      return;
    }
    void audio
      .play()
      .then(() => {
        if (version === playbackVersion && wantsAudio())
          setPlayState(true);
      })
      .catch(() => {
        // A blocked autoplay request is surfaced as the existing unmute action.
        if (version === playbackVersion)
          setPlayState(false);
      });
  });

  const setPlay = (state: boolean) => {
    // A rejected autoplay attempt can leave wantsAudio true. Retry directly
    // within the explicit user gesture even when that preference is unchanged.
    if (state && wantsAudio()) {
      const audio = audioRef();
      if (!audio || !audioStream()) return;
      const version = ++playbackVersion;
      void audio
        .play()
        .then(() => {
          if (version === playbackVersion && wantsAudio())
            setPlayState(true);
        })
        .catch(() => {
          if (version === playbackVersion)
            setPlayState(false);
        });
    } else setWantsAudio(state);
  };

  onCleanup(() => {
    disposed = true;
    setOutputBusy(false);
    ++playbackVersion;
    const audio = audioRef();
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
  });

  return {
    value: {
      hasAudio: createMemo(() => tracks().length > 0),
      playState,
      setPlay,
      hasPeerAudio: (id) => !!peerTracks().get(id)?.length,
      isPeerMuted,
      setPeerMuted,
      isSourceMuted,
      setSourceMuted,
      outputDeviceId,
      outputSupported,
      outputBusy,
      setOutputDevice,
    },
    attach(element) {
      setAudioRef(element);
      // A view can replace its DOM node without replacing the meeting owner.
      const selected = outputDeviceId();
      if (selected)
        void setOutputDevice(selected).catch(() => {
          if (audioRef() === element) setOutputDeviceId("");
        });
    },
    detach(element) {
      if (audioRef() !== element) return;
      ++playbackVersion;
      element.pause();
      element.srcObject = null;
      setAudioRef(undefined);
      setPlayState(false);
    },
    onPlaying(element) {
      if (audioRef() !== element) return;
      if (!wantsAudio()) {
        audioRef()?.pause();
        return;
      }
      setPlayState(true);
    },
    onPause(element) {
      if (audioRef() !== element) return;
      setPlayState(false);
    },
  };
}
