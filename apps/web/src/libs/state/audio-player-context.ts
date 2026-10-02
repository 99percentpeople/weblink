import {
  createContext,
  useContext,
  type Accessor,
} from "solid-js";
export type AudioPlayerContextValue = {
  hasAudio: Accessor<boolean>;
  playState: Accessor<boolean>;
  setPlay: (state: boolean) => void;
  hasPeerAudio(id: string): boolean;
  isPeerMuted(id: string): boolean;
  setPeerMuted(id: string, muted: boolean): void;
  isSourceMuted(peerId: string, sourceId: string): boolean;
  setSourceMuted(
    peerId: string,
    sourceId: string,
    muted: boolean,
  ): void;
  outputDeviceId: Accessor<string>;
  outputSupported: Accessor<boolean>;
  outputBusy: Accessor<boolean>;
  setOutputDevice(id: string): Promise<void>;
};
export const AudioPlayerContext =
  createContext<AudioPlayerContextValue>();
export const useAudioPlayer = () => {
  const context = useContext(AudioPlayerContext);
  if (!context)
    throw new Error("Audio player context not found");
  return context;
};
