import type { RemotePointer } from "../remote-control/pointer";
import { ScreenDecodeError } from "./errors";
/** A receive-only native screen connection. Source identity comes from its control
 * channel and paired video/audio transceivers, never the sender's MediaStreamTrack.id. */
export class ScreenReceiver {
  readonly pc: RTCPeerConnection;
  readonly stream = new MediaStream();
  private readonly lifetime = new AbortController();
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private remoteReady = false;
  private candidates: RTCIceCandidateInit[] = [];
  private decodeTimer?: ReturnType<typeof setTimeout>;
  constructor(
    configuration: RTCConfiguration,
    private readonly changed: (
      stream: MediaStream | null,
    ) => void,
    private readonly failed: (error: Error) => void,
    private readonly onCandidate?: (
      candidate: RTCIceCandidateInit,
    ) => void,
    private readonly control?: RemotePointer,
  ) {
    this.pc = new RTCPeerConnection(configuration);
    control?.addEventListener(
      "transporterror",
      () => {
        this.fail(
          new Error("Native control connection ended"),
        );
      },
      { signal: this.lifetime.signal },
    );
    this.pc.addEventListener(
      "datachannel",
      ({ channel }) => {
        if (control) control.bind(channel);
        else channel.close();
      },
      { signal: this.lifetime.signal },
    );
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
        else if (this.pc.connectionState === "closed")
          this.fail(
            new Error("Native screen connection closed"),
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
    const answer = await this.pc.createAnswer();
    const video = answer.sdp
      ?.split(/(?=^m=)/m)
      .find((section) => section.startsWith("m=video "));
    if (
      /^m=video /m.test(sdp) &&
      (!video ||
        /^m=video 0(?:\s|\/)/.test(video) ||
        /^a=(inactive|sendonly)\r?$/m.test(video))
    ) {
      this.close();
      throw new ScreenDecodeError();
    }
    await this.pc.setLocalDescription(answer);
    this.lifetime.signal.throwIfAborted();
    if (!this.onCandidate)
      await this.waitFor(
        () => this.pc.iceGatheringState === "complete",
        "icegatheringstatechange",
        15000,
      );
    return this.pc.localDescription!.sdp;
  }
  /** Receiving RTP is not proof that the advertised decoder actually works. */
  monitorDecode(healthy: () => void): void {
    let lastFrames = 0;
    let stalledSince: number | undefined;
    let lastBytes = 0;
    let healthySince: number | undefined;
    let reportedHealthy = false;
    const poll = async () => {
      try {
        const stats = await this.pc.getStats();
        if (this.lifetime.signal.aborted) return;
        if (this.pc.connectionState === "connected") {
          stats.forEach((stat) => {
            if (
              stat.type !== "inbound-rtp" ||
              (stat.kind ?? stat.mediaType) !== "video"
            )
              return;
            if (typeof stat.framesDecoded !== "number")
              return;
            const now = Date.now();
            const bytes = stat.bytesReceived ?? 0;
            if (stat.framesDecoded > lastFrames) {
              stalledSince = undefined;
              healthySince ??= now;
              if (
                !reportedHealthy &&
                now - healthySince >= 10000
              ) {
                reportedHealthy = true;
                healthy();
              }
            } else if (bytes > lastBytes) {
              healthySince = undefined;
              stalledSince ??= now;
              if (now - stalledSince >= 12000)
                this.fail(
                  new ScreenDecodeError(
                    "Video data is arriving but this receiver's decoder is not producing frames.",
                  ),
                );
            } else {
              // A silent sender/network cannot establish decoder failure.
              stalledSince = undefined;
              healthySince = undefined;
            }
            lastFrames = stat.framesDecoded;
            lastBytes = bytes;
          });
        } else {
          stalledSince = undefined;
          healthySince = undefined;
        }
      } catch {
        // Statistics are optional; a failed read cannot end a healthy stream.
      } finally {
        if (!this.lifetime.signal.aborted)
          this.decodeTimer = setTimeout(
            () => void poll(),
            1000,
          );
      }
    };
    clearTimeout(this.decodeTimer);
    void poll();
  }
  decodeFailed(): void {
    this.fail(new ScreenDecodeError());
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
    this.control?.close();
    this.lifetime.abort();
    this.candidates = [];
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.decodeTimer);
    this.pc.close();
    this.stream
      .getTracks()
      .forEach((track) => track.stop());
    this.changed(null);
  }
}
