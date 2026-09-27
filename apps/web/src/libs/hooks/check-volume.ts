import {
  Accessor,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";

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

  let audioContext: AudioContext | undefined;
  let timer: number | undefined;
  createEffect(() => {
    const checkStream = stream();

    setSpeaking(false);
    if (audioContext) {
      audioContext.close();
      audioContext = undefined;
    }
    if (timer) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (!checkStream) return;
    if (checkStream.getAudioTracks().length === 0) return;
    const context: AudioContext = new AudioContext();
    audioContext = context;
    const source =
      context.createMediaStreamSource(checkStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);

    const checkVolume = () => {
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
        if (context.state === "closed") return;
        requestAnimationFrame(checkVolume);
      }, options.interval);
    };
    checkVolume();
  });
  onCleanup(() => {
    audioContext?.close();
  });
  return speaking;
};
