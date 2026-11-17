/** One video frame on the sender's monotonic clock. Durations use milliseconds.
 * No receiver clock, RTT or interval averages participate in these values. */
export interface VideoSendFrameStats {
  ssrc: number;
  rtpTimestamp: number;
  ageMs: number;
  /** Capture to the encoded-frame callback immediately before packetization.
   * Includes encoder output delivery and transform scheduling. */
  captureToPacketizerMs: number;
  /** Packetizer input to successful submission of the original marker packet
   * to the RTP transport. Includes packetization and pacing, not retransmits. */
  packetizerToSendMs?: number;
  /** Same frame, capture to original marker packet transport submission. */
  captureToSendMs?: number;
  endpoint: "packetizer-input" | "transport-submit";
}
