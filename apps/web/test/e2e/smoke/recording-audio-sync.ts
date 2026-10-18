import {
  ALL_FORMATS,
  BufferSource,
  Input,
  VideoSampleSink,
} from "mediabunny";

/** The source flashes a white corner while the tone is on. Compare decoded
 * content, not unrelated RTP timestamps, to catch a constant audio/video offset. */
export async function checkRecordingAudioSync(
  content: ArrayBuffer,
  audio: AudioBuffer,
): Promise<number> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(content),
  });
  const pixels = new OffscreenCanvas(1, 1).getContext(
    "2d",
  )!;
  try {
    const video = (await input.getPrimaryVideoTrack())!;
    const sink = new VideoSampleSink(video);
    const channel = audio.getChannelData(0);
    const rms = (time: number) => {
      const start = Math.round(time * audio.sampleRate),
        count = Math.round(audio.sampleRate * 0.02);
      let sum = 0;
      for (
        let at = start;
        at < Math.min(channel.length, start + count);
        at++
      )
        sum += channel[at] ** 2;
      return Math.sqrt(sum / count);
    };
    let checked = 0;
    for (
      let time = 0.3;
      time < audio.duration - 0.3;
      time += 0.05
    ) {
      // Sample the middle of a pulse, away from frame/packet boundary rounding.
      if (rms(time - 0.05) < 0.1 || rms(time + 0.05) < 0.1)
        continue;
      const sample = await sink.getSample(time);
      if (!sample)
        throw new Error(
          "No recording video at audio pulse",
        );
      try {
        sample.draw(pixels, 8, 8, 8, 8, 0, 0, 1, 1);
        if (pixels.getImageData(0, 0, 1, 1).data[0] < 180)
          throw new Error(
            `Recorded audio/video pulse is out of sync at ${time.toFixed(3)} seconds`,
          );
        checked++;
      } finally {
        sample.close();
      }
      if (checked >= 3) break;
      time += 0.4;
    }
    if (!checked)
      throw new Error(
        "No recording audio/video synchronization samples",
      );
    return checked;
  } finally {
    input.dispose();
  }
}
