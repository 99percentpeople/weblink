/** A receive-only native screen connection. Source identity comes from its control
 * channel and paired video/audio transceivers, never the sender's MediaStreamTrack.id. */
export class ScreenReceiver {
  readonly pc: RTCPeerConnection;
  readonly stream = new MediaStream();
  private readonly lifetime = new AbortController();
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private remoteReady = false;
  private candidates: RTCIceCandidateInit[] = [];
  constructor(
    configuration: RTCConfiguration,
    private readonly changed: (
      stream: MediaStream | null,
    ) => void,
    private readonly failed: (error: Error) => void,
    private readonly onCandidate?: (
      candidate: RTCIceCandidateInit,
    ) => void,
  ) {
    this.pc = new RTCPeerConnection(configuration);
    if (onCandidate)
      this.pc.addEventListener(
        "icecandidate",
        ({ candidate }) => {
          if (candidate?.candidate)
            onCandidate(candidate.toJSON());
        },
        { signal: this.lifetime.signal },
      );
    this.pc.addEventListener(
      "track",
      (event) => {
        if (
          !["video", "audio"].includes(event.track.kind) ||
          this.stream
            .getTracks()
            .some(
              (track) => track.kind === event.track.kind,
            )
        )
          return;
        // Interactive screen viewing should not intentionally accumulate
        // video/audio playout delay when a large scene cut arrives.
        const receiver =
          event.receiver as RTCRtpReceiver & {
            jitterBufferTarget?: number | null;
            playoutDelayHint?: number;
          };
        for (const property of [
          "jitterBufferTarget",
          "playoutDelayHint",
        ] as const) {
          try {
            if (property in receiver)
              receiver[property] = 0;
          } catch {
            // Older WebViews can expose an unsupported experimental setter.
          }
        }
        this.stream.addTrack(event.track);
        event.track.addEventListener(
          "ended",
          () => {
            if (event.track.kind === "video")
              this.fail(new Error("Native screen ended"));
            else {
              this.stream.removeTrack(event.track);
              this.changed(
                new MediaStream(this.stream.getTracks()),
              );
            }
          },
          { signal: this.lifetime.signal },
        );
        this.changed(
          new MediaStream(this.stream.getTracks()),
        );
      },
      { signal: this.lifetime.signal },
    );
    this.pc.addEventListener(
      "connectionstatechange",
      () => {
        clearTimeout(this.disconnectTimer);
        if (this.pc.connectionState === "failed")
          this.fail(
            new Error("Native screen connection failed"),
          );
        else if (this.pc.connectionState === "disconnected")
          this.disconnectTimer = setTimeout(
            () =>
              this.fail(
                new Error("Native screen disconnected"),
              ),
            8000,
          );
      },
      { signal: this.lifetime.signal },
    );
  }
  async answer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({
      type: "offer",
      sdp,
    });
    if (this.lifetime.signal.aborted)
      throw new Error("Native screen closed");
    this.remoteReady = true;
    for (const candidate of this.candidates.splice(0))
      await this.addIceCandidate(candidate);
    await this.pc.setLocalDescription(
      await this.pc.createAnswer(),
    );
    if (!this.onCandidate)
      await this.waitFor(
        () => this.pc.iceGatheringState === "complete",
        "icegatheringstatechange",
        15000,
      );
    return this.pc.localDescription!.sdp;
  }
  async addIceCandidate(
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    if (!this.remoteReady) {
      if (this.candidates.length >= 256)
        throw new Error("Too many native ICE candidates");
      this.candidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }
  async connected(audio = false): Promise<void> {
    await this.waitFor(
      () =>
        this.pc.connectionState === "connected" &&
        this.stream.getVideoTracks().length > 0 &&
        (!audio || this.stream.getAudioTracks().length > 0),
      "connectionstatechange",
      20000,
    );
  }
  private waitFor(
    done: () => boolean,
    event: string,
    ms: number,
  ): Promise<void> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(
        new Error("Native screen closed"),
      );
    if (done()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.pc.removeEventListener(event, check);
        this.pc.removeEventListener("track", check);
        this.lifetime.signal.removeEventListener(
          "abort",
          aborted,
        );
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const aborted = () =>
        finish(new Error("Native screen closed"));
      const timer = setTimeout(
        () =>
          finish(
            new Error("Native screen connection timed out"),
          ),
        ms,
      );
      this.pc.addEventListener(event, check);
      this.pc.addEventListener("track", check);
      this.lifetime.signal.addEventListener(
        "abort",
        aborted,
        { once: true },
      );
      check();
    });
  }
  private fail(error: Error) {
    if (this.lifetime.signal.aborted) return;
    this.close();
    this.failed(error);
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.candidates = [];
    clearTimeout(this.disconnectTimer);
    this.pc.close();
    this.stream
      .getTracks()
      .forEach((track) => track.stop());
    this.changed(null);
  }
}
