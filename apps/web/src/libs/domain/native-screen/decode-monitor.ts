interface DecodeSample {
  frames: number;
  bytes: number;
  stalledSince?: number;
  healthySince?: number;
}

/** Only consecutive, foreground observations can establish a video stall. */
export function monitorScreenDecode(
  pc: RTCPeerConnection,
  healthy: () => void,
  stalled: () => void,
): () => void {
  const events = new AbortController();
  const page =
    typeof document === "undefined" ? undefined : document;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let samples = new Map<string, DecodeSample>();
  let lastReadAt: number | undefined;
  let revision = 0;
  let frozen = false;
  let reportedHealthy = false;
  const reset = () => {
    revision++;
    samples.clear();
    lastReadAt = undefined;
  };
  const stop = () => {
    events.abort();
    clearTimeout(timer);
    reset();
  };
  const listener = { signal: events.signal };
  page?.addEventListener(
    "visibilitychange",
    reset,
    listener,
  );
  page?.addEventListener(
    "freeze",
    () => {
      frozen = true;
      reset();
    },
    listener,
  );
  page?.addEventListener(
    "resume",
    () => {
      frozen = false;
      reset();
    },
    listener,
  );
  pc.addEventListener(
    "connectionstatechange",
    reset,
    listener,
  );
  const poll = async () => {
    try {
      if (
        frozen ||
        page?.visibilityState === "hidden" ||
        pc.connectionState !== "connected"
      ) {
        reset();
        return;
      }
      const observedRevision = revision;
      const stats = await pc.getStats();
      if (
        events.signal.aborted ||
        observedRevision !== revision
      )
        return;
      const now = Date.now();
      // Timers/statistics may be suspended without a page lifecycle event.
      // A delayed sample cannot prove continuous decoding failure or health.
      if (
        lastReadAt !== undefined &&
        (now - lastReadAt > 3000 || now < lastReadAt)
      )
        samples.clear();
      lastReadAt = now;
      const next = new Map<string, DecodeSample>();
      let failed = false;
      stats.forEach((stat, id) => {
        if (
          stat.type !== "inbound-rtp" ||
          (stat.kind ?? stat.mediaType) !== "video" ||
          stat.active === false ||
          typeof stat.framesDecoded !== "number" ||
          typeof stat.bytesReceived !== "number"
        )
          return;
        const sample: DecodeSample = {
          frames: stat.framesDecoded,
          bytes: stat.bytesReceived,
        };
        next.set(id, sample);
        const previous = samples.get(id);
        if (
          !previous ||
          sample.frames < previous.frames ||
          sample.bytes < previous.bytes
        )
          return;
        if (sample.frames > previous.frames) {
          sample.healthySince =
            previous.healthySince ?? now;
          if (
            !reportedHealthy &&
            now - sample.healthySince >= 10000
          ) {
            reportedHealthy = true;
            healthy();
          }
        } else if (sample.bytes > previous.bytes) {
          sample.stalledSince =
            previous.stalledSince ?? now;
          failed ||= now - sample.stalledSince >= 12000;
        }
        // No incoming bytes cannot establish a decoder failure. Missing/reset
        // reports also start a fresh observation window for that RTP stream.
      });
      samples = next;
      if (failed && !events.signal.aborted) {
        stop();
        stalled();
      }
    } catch {
      // An unreadable interval provides no evidence of a continuous stall.
      reset();
    } finally {
      if (!events.signal.aborted)
        timer = setTimeout(() => void poll(), 1000);
    }
  };
  void poll();
  return stop;
}
