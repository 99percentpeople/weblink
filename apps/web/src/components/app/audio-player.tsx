import { onCleanup, type ParentProps } from "solid-js";
import { AudioPlayerContext } from "@/libs/state/audio-player-context";
import type { AudioPlayerController } from "@/libs/state/create-audio-player";
export function AudioPlayerView(props: {
  player: AudioPlayerController;
}) {
  let element!: HTMLAudioElement;
  onCleanup(() => {
    if (element) props.player.detach(element);
  });
  return (
    <audio
      ref={(audio) => {
        element = audio;
        props.player.attach(audio);
      }}
      class="hidden"
      onPlaying={(event) =>
        props.player.onPlaying(event.currentTarget)
      }
      onPause={(event) =>
        props.player.onPause(event.currentTarget)
      }
    />
  );
}
export function AudioPlayerProvider(
  props: ParentProps<{ value: AudioPlayerController }>,
) {
  return (
    <AudioPlayerContext.Provider value={props.value.value}>
      <AudioPlayerView player={props.value} />
      {props.children}
    </AudioPlayerContext.Provider>
  );
}
