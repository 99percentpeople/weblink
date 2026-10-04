import {
  Accessor,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { createPresentationVisible } from "./presentation-visible";

type CheckVolumeOptions = {
  speakingThreshold: number;
  interval: number;
};

export const createCheckVolume = (
  stream: Accessor<MediaStream | null>,
  options: CheckVolumeOptions = {
    speakingThreshold: 20,
    interval: 100,
  },
) => {
  const [speaking, setSpeaking] = createSignal(false);
  const visible = createPresentationVisible();
  createEffect(() => {
    const checkStream = stream();

    setSpeaking(false);
    if (!checkStream || !visible()) return;
    if (checkStream.getAudioTracks().length === 0) return;
    const context: AudioContext = new AudioContext();
    const source =
      context.createMediaStreamSource(checkStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);
    let stopped = false;
    let timer: number | undefined;
    let frame: number | undefined;

    const checkVolume = () => {
      frame = undefined;
      if (stopped) return;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        let val = dataArray[i];
        sum += val * val;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      setSpeaking(rms > options.speakingThreshold);

      timer = window.setTimeout(() => {
        timer = undefined;
        if (stopped || context.state === "closed") return;
        frame = requestAnimationFrame(checkVolume);
      }, options.interval);
    };
    checkVolume();
    onCleanup(() => {
      stopped = true;
      window.clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(console.warn);
    });
  });
  return speaking;
};
