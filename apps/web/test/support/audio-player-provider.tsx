import type { ParentProps } from "solid-js";
import { createAudioPlayer } from "@/libs/state/create-audio-player";
import { AudioPlayerProvider as InjectAudio } from "@/components/app/audio-player";

export function AudioPlayerProvider(props: ParentProps) {
  const value = createAudioPlayer();
  return (
    <InjectAudio value={value}>
      {props.children}
    </InjectAudio>
  );
}
