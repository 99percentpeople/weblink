// 48 kHz stereo PCM from the native WebRTC audio sink. Bound the queue to
// 40 ms; after suspension resume at the newest audio instead of playing history.
class ReceiveAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.samples = 0;
    this.port.onmessage = ({ data }) => {
      if (
        !(data instanceof ArrayBuffer) ||
        !data.byteLength ||
        data.byteLength % 4 ||
        data.byteLength > 7680
      )
        return;
      const pcm = new Int16Array(data);
      this.queue.push(pcm);
      this.samples += pcm.length;
      while (this.samples > 3840 && this.queue.length > 1) {
        this.samples -=
          this.queue.shift().length - this.offset;
        this.offset = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    for (let i = 0; i < output[0].length; i++) {
      const pcm = this.queue[0];
      if (!pcm) break;
      output[0][i] = pcm[this.offset++] / 32768;
      output[1][i] = pcm[this.offset++] / 32768;
      this.samples -= 2;
      if (this.offset >= pcm.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("weblink-receive-audio", ReceiveAudio);
