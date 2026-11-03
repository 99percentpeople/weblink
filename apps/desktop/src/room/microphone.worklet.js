// One IPC write in flight. Over short stalls, retain up to 80 ms of complete stereo blocks.
class MeetingMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(960);
    this.offset = 0;
    this.ready = true;
    this.pending = [];
    this.port.onmessage = () => {
      this.ready = true;
      this.flush();
    };
  }
  flush() {
    if (!this.ready || !this.pending.length) return;
    const batch =
      this.pending.length === 1
        ? this.pending[0]
        : new Int16Array(this.pending.length * 960);
    if (this.pending.length > 1)
      this.pending.forEach((block, i) =>
        batch.set(block, i * 960),
      );
    this.pending.length = 0;
    this.ready = false;
    this.port.postMessage(batch.buffer, [batch.buffer]);
  }
  process(inputs) {
    const [left, right = left] = inputs[0] ?? [];
    if (!left) return true;
    for (let i = 0; i < left.length; i++) {
      this.samples[this.offset++] = Math.max(
        -32768,
        Math.min(32767, left[i] * 32768),
      );
      this.samples[this.offset++] = Math.max(
        -32768,
        Math.min(32767, right[i] * 32768),
      );
      if (this.offset === this.samples.length) {
        this.offset = 0;
        if (this.pending.length === 8) this.pending.shift();
        this.pending.push(this.samples);
        this.samples = new Int16Array(960);
        this.flush();
      }
    }
    return true;
  }
}
registerProcessor(
  "weblink-room-microphone",
  MeetingMicrophone,
);
