import { createContext, type Accessor } from "solid-js";
export const VideoContext = createContext<{
  videoRef: Accessor<HTMLVideoElement | null>;
  videoTrack: Accessor<MediaStreamTrack | null>;
  audioTracks: Accessor<MediaStreamTrack[]>;
}>();
