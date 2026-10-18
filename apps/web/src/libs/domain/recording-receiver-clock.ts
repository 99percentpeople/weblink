/** Map independent audio/video RTP clocks to the receiver's shared delivery clock.
 * Arrival timestamps are not used: getSynchronizationSources describes frames
 * actually delivered to the MediaStreamTrack, after WebRTC's synchronization. */
export class RecordingReceiverClock {
  private segment = -1;
  private anchor?: RTCRtpSynchronizationSource;
  private lastRtp = 0;
  private timestamp = 0;
  constructor(private readonly receiver: RTCRtpReceiver) {}
  reset(): void {
    this.segment = -1;
    this.anchor = undefined;
  }
  time(
    packet: {
      timestamp: number;
      ssrc: number;
      segment: number;
    },
    rate: number,
  ): number | undefined {
    if (
      packet.segment !== this.segment ||
      this.anchor?.source !== packet.ssrc
    ) {
      this.segment = packet.segment;
      try {
        const source = this.receiver
          .getSynchronizationSources?.()
          .find(
            (entry) =>
              entry.source === packet.ssrc &&
              Number.isFinite(entry.rtpTimestamp),
          );
        this.anchor = undefined;
        if (source) {
          // Chromium versions also expose epoch-based timestamps here. Normalize
          // either representation to the same main-thread performance clock.
          const now = performance.now();
          const timestamp =
            Math.abs(now - source.timestamp) < 2000
              ? source.timestamp
              : source.timestamp - performance.timeOrigin;
          if (
            Number.isFinite(timestamp) &&
            Math.abs(now - timestamp) < 2000
          ) {
            this.anchor = { ...source, timestamp };
            this.lastRtp = source.rtpTimestamp;
            this.timestamp = timestamp;
          }
        }
      } catch {
        this.anchor = undefined;
      }
    }
    if (!this.anchor) return;
    // Unwrap incrementally so long recordings can cross any number of RTP wraps.
    const ticks = (packet.timestamp - this.lastRtp) | 0;
    this.timestamp += (ticks * 1000) / rate;
    this.lastRtp = packet.timestamp;
    return this.timestamp;
  }
}
