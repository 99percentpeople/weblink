import type { EncodedPacket } from "mediabunny";

const RADIUS = 3;
const MAX_INTERVAL = 1 / 60;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/** Write each access unit once its successor establishes the display duration. */
export class RecordingVideoWriter {
  private readonly cadence = new RecordingVideoCadence();
  private pending?: EncodedPacket;
  private lastDuration = 0;

  constructor(
    private readonly write: (
      packet: EncodedPacket,
    ) => Promise<void>,
  ) {}

  add(
    packet: EncodedPacket,
    smooth: boolean,
  ): Promise<void> {
    return this.append(
      smooth ? this.cadence.add(packet) : [packet],
    );
  }

  drainCadence(): Promise<void> {
    return this.append(this.cadence.drain());
  }

  private async append(
    packets: EncodedPacket[],
  ): Promise<void> {
    for (const next of packets) {
      const previous = this.pending;
      this.pending = next;
      if (previous) {
        const interval =
          next.timestamp - previous.timestamp;
        this.lastDuration =
          interval >= 0 ? interval : previous.duration;
        await this.write(
          previous.clone({ duration: this.lastDuration }),
        );
      }
    }
  }

  async finish(end?: number): Promise<void> {
    await this.drainCadence();
    const last = this.pending;
    if (!last) return;
    this.pending = undefined;
    const duration =
      end === undefined
        ? last.duration || this.lastDuration
        : end - last.timestamp;
    await this.write(last.clone({ duration }));
  }
}

/** Smooth presentation times only within a burst of high-rate desktop capture.
 * Keep the original endpoints, audio clock and every encoded frame. */
export class RecordingVideoCadence {
  private history: number[] = [];
  private pending: EncodedPacket[] = [];
  private bytes = 0;

  add(frame: EncodedPacket): EncodedPacket[] {
    const last =
      this.pending.at(-1)?.timestamp ?? this.history.at(-1);
    const gap =
      last === undefined ? 0 : frame.timestamp - last;
    const ready =
      gap <= 0 ||
      gap >= MAX_INTERVAL ||
      this.bytes + frame.data.byteLength >
        MAX_BUFFERED_BYTES
        ? this.drain()
        : [];
    this.pending.push(frame);
    this.bytes += frame.data.byteLength;
    // At the beginning use only as many future frames as we have past ones.
    if (this.pending.length > this.history.length)
      ready.push(this.take());
    return ready;
  }

  drain(): EncodedPacket[] {
    const ready: EncodedPacket[] = [];
    while (this.pending.length) ready.push(this.take());
    this.history = [];
    return ready;
  }

  private take(): EncodedPacket {
    const frame = this.pending.shift()!;
    this.bytes -= frame.data.byteLength;
    const capturedAt = frame.timestamp;
    const radius = Math.min(
      this.history.length,
      this.pending.length,
    );
    let result = frame;
    if (radius) {
      // A centered mean leaves a uniform cadence exactly where it was.
      // Clamp within the neighboring capture midpoints to preserve ordering.
      let offsetSum = 0;
      for (let i = 1; i <= radius; i++) {
        offsetSum += this.history.at(-i)! - capturedAt;
        offsetSum +=
          this.pending[i - 1].timestamp - capturedAt;
      }
      const earliest =
        (this.history.at(-1)! - capturedAt) / 2;
      const latest =
        (this.pending[0].timestamp - capturedAt) / 2;
      const mean = offsetSum / (2 * radius + 1);
      const offset = Math.max(
        earliest,
        Math.min(latest, mean),
      );
      result = frame.clone({
        timestamp: capturedAt + offset,
      });
    }
    this.history.push(capturedAt);
    if (this.history.length > RADIUS) this.history.shift();
    return result;
  }
}
