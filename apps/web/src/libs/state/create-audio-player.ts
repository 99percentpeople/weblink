import { appState } from "@/libs/state/app-state";
import {
  AudioPlayback,
  type AudioPlaybackState,
} from "@/libs/application/audio-playback";
import { createStore } from "solid-js/store";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  getRemoteAudioVideoTrackId,
  meetingAudioSourceId,
} from "@/routes/home/components/meeting-audio-sources";

import type { AudioPlayerContextValue } from "./audio-player-context";

export interface AudioPlayerController {
  readonly value: AudioPlayerContextValue;
  readonly tracks: Accessor<readonly MediaStreamTrack[]>;
  attach(
    element: HTMLAudioElement,
    track?: MediaStreamTrack,
  ): void;
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
  const [output, setOutput] =
    createStore<AudioPlaybackState>({
      playing: false,
      outputSupported: false,
      outputDeviceId: "",
      outputBusy: false,
    });
  const playback = new AudioPlayback(setOutput);
  onCleanup(() => playback.dispose());

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

  return {
    tracks,
    value: {
      hasAudio: createMemo(() => tracks().length > 0),
      playState: () => output.playing,
      setPlay: (state) => playback.setPlay(state),
      hasPeerAudio: (id) => !!peerTracks().get(id)?.length,
      isPeerMuted,
      setPeerMuted,
      isSourceMuted,
      setSourceMuted,
      outputDeviceId: () => output.outputDeviceId,
      outputSupported: () => output.outputSupported,
      outputBusy: () => output.outputBusy,
      setOutputDevice: (id) => playback.setOutputDevice(id),
    },
    attach: (element, track) =>
      playback.attach(element, track),
    detach: (element) => playback.detach(element),
    onPlaying: (element) => playback.onPlaying(element),
    onPause: (element) => playback.onPause(element),
  };
}
