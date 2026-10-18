import type {
  EncodedVideoPacket,
  EncodedAudioPacket,
  EncodedVideoSource,
} from "./encoded-video";
import SenderWorker from "./rtp-encoded-media.worker?worker&inline";
import { RecordingReceiverClock } from "./recording-receiver-clock";

type Consumer = Parameters<
  EncodedVideoSource["subscribe"]
>[0];
interface Subscription {
  id: number;
  callbacks: Consumer;
  queue: Promise<void>;
  stopping?: Promise<void>;
  stopped?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Share one worker among a connection's senders and receivers. */
export class RtpEncodedMediaWorkers {
  private worker?: Worker;
  private references = 0;
  acquire() {
    this.worker ??= new SenderWorker();
    this.references++;
    let released = false;
    return {
      worker: this.worker,
      release: () => {
        if (released) return;
        released = true;
        if (--this.references === 0) {
          this.worker?.terminate();
          this.worker = undefined;
        }
      },
    };
  }
}

/** Install at track creation, before the browser bypasses transforms. */
export class RtpEncodedMediaTrack implements EncodedVideoSource {
  private readonly channel = new MessageChannel();
  private sequence = 0;
  private consumer?: Subscription;
  private disposed = false;
  private receiverClock?: RecordingReceiverClock;
  private readonly trackEnded = () => this.end();
  private readonly track: MediaStreamTrack | null;
  private dimensions?: {
    ssrc: number;
    width: number;
    height: number;
  };
  private readonly connectionChanged = () => {
    if (
      ["disconnected", "failed", "closed"].includes(
        this.pc.connectionState,
      )
    )
      this.end();
  };

  static install(
    sender: RTCRtpSender | RTCRtpReceiver,
    pc: RTCPeerConnection,
    workers = new RtpEncodedMediaWorkers(),
    direction: "send" | "receive" = "send",
  ): RtpEncodedMediaTrack | undefined {
    if (
      !["video", "audio"].includes(
        sender.track?.kind ?? "",
      ) ||
      typeof RTCRtpScriptTransform !== "function" ||
      typeof Worker !== "function" ||
      sender.transform
    )
      return;
    let lease:
      | ReturnType<RtpEncodedMediaWorkers["acquire"]>
      | undefined;
    try {
      // Bundle the worker with this module so a missing worker asset cannot
      // strand an already attached sender transform after deployment.
      lease = workers.acquire();
      return new RtpEncodedMediaTrack(
        sender,
        pc,
        lease,
        direction,
      );
    } catch {
      lease?.release();
      return;
    }
  }

  private constructor(
    private readonly sender: RTCRtpSender | RTCRtpReceiver,
    private readonly pc: RTCPeerConnection,
    private readonly lease: ReturnType<
      RtpEncodedMediaWorkers["acquire"]
    >,
    private readonly direction: "send" | "receive",
  ) {
    this.track = sender.track;
    this.receiverClock =
      direction === "receive"
        ? new RecordingReceiverClock(
            sender as RTCRtpReceiver,
          )
        : undefined;
    this.channel.port1.onmessage = ({ data }) => {
      const consumer = this.consumer;
      if (!consumer || data.id !== consumer.id) return;
      if (data.packet) {
        const packet = data.packet as
          | EncodedVideoPacket
          | EncodedAudioPacket;
        if (this.receiverClock)
          packet.clockTime = this.receiverClock.time(
            packet,
            sender.track?.kind === "audio"
              ? ((packet as EncodedAudioPacket).clockRate ??
                  (packet as EncodedAudioPacket).sampleRate)
              : 90000,
          );
        const bytes = packet.data.byteLength;
        consumer.queue = consumer.queue
          .then(async () => {
            if (this.sender.track?.kind === "audio")
              return consumer.callbacks.encodedAudio?.(
                packet as EncodedAudioPacket,
              );
            const video = packet as EncodedVideoPacket;
            await this.describeVideo(video);
            return consumer.callbacks.frame(video);
          })
          .catch((error) =>
            this.end(
              error instanceof Error
                ? error
                : new Error(String(error)),
            ),
          )
          .finally(() =>
            this.send("ack", consumer.id, bytes),
          );
      } else if (data.error)
        this.end(new Error(data.error));
      else if (data.command === "stop")
        consumer.stopped?.();
      else if (
        data.command === "resume" &&
        !consumer.stopping
      )
        this.requestKeyFrame();
    };
    lease.worker.addEventListener(
      "error",
      this.workerFailed,
    );
    sender.transform = new RTCRtpScriptTransform(
      lease.worker,
      {
        port: this.channel.port2,
        kind: sender.track?.kind,
        direction,
      },
      [this.channel.port2],
    );
    pc.addEventListener(
      "connectionstatechange",
      this.connectionChanged,
    );
    this.track?.addEventListener?.(
      "ended",
      this.trackEnded,
    );
  }

  private readonly workerFailed = () =>
    this.end(
      new Error("Recording encoded-frame worker failed"),
    );

  private async describeVideo(
    packet: EncodedVideoPacket,
  ): Promise<void> {
    if (this.direction !== "receive") return;
    // Some receivers (notably Chromium AV1) omit dimensions even on keyframes.
    // Read the already decoded stream's dimensions, never open another decoder.
    if (
      packet.type === "key" &&
      (!packet.width || !packet.height)
    ) {
      const stats = await this.sender.getStats();
      for (const stat of stats.values()) {
        if (
          stat.type === "inbound-rtp" &&
          stat.ssrc === packet.ssrc &&
          stat.frameWidth > 0 &&
          stat.frameHeight > 0
        ) {
          packet.width = stat.frameWidth;
          packet.height = stat.frameHeight;
          break;
        }
      }
    }
    if (packet.width > 0 && packet.height > 0)
      this.dimensions = {
        ssrc: packet.ssrc,
        width: packet.width,
        height: packet.height,
      };
    else if (this.dimensions?.ssrc === packet.ssrc) {
      packet.width = this.dimensions.width;
      packet.height = this.dimensions.height;
    }
  }

  private send(
    command: string,
    id: number,
    bytes?: number,
  ) {
    if (!this.disposed)
      this.channel.port1.postMessage({
        command,
        id,
        bytes,
      });
  }

  private requestKeyFrame() {
    if (
      this.direction !== "send" ||
      this.sender.track?.kind !== "video"
    )
      return;
    try {
      const sender = this.sender as RTCRtpSender & {
        setParameters(
          parameters: RTCRtpSendParameters,
          options: {
            encodingOptions: { keyFrame: boolean }[];
          },
        ): Promise<void>;
      };
      const parameters = sender.getParameters();
      void sender
        .setParameters(parameters, {
          encodingOptions: parameters.encodings.map(() => ({
            keyFrame: true,
          })),
        })
        .catch(() => {});
    } catch {
      // Closing/replacing a sender can race this request. Preparation and resume
      // are bounded; no recording failure is allowed to reconfigure the sender.
    }
  }

  subscribe(callbacks: Consumer) {
    if (
      this.disposed ||
      this.consumer ||
      this.pc.connectionState !== "connected" ||
      this.sender.track?.readyState !== "live"
    )
      return null;
    const encodings = (
      this.sender.getParameters() as RTCRtpSendParameters
    ).encodings;
    // Do not mix simulcast representations or spatial enhancement layers.
    if (
      this.direction === "send" &&
      this.sender.track?.kind === "video" &&
      (encodings.length !== 1 ||
        encodings[0].active === false ||
        /^(L[2-9]|S[2-9])/.test(
          (
            encodings[0] as RTCRtpEncodingParameters & {
              scalabilityMode?: string;
            }
          ).scalabilityMode ?? "",
        ))
    )
      return null;
    const consumer = (this.consumer = {
      id: ++this.sequence,
      callbacks,
      queue: Promise.resolve(),
    } as Subscription);
    this.receiverClock?.reset();
    this.channel.port1.postMessage({
      command: "start",
      id: consumer.id,
      codecs: this.sender.getParameters().codecs,
    });
    const stop = () => {
      if (consumer.stopping) return consumer.stopping;
      consumer.stopping = new Promise<void>((resolve) => {
        consumer.stopped = resolve;
        // A dead connection must not leave saving stuck waiting for its Worker.
        consumer.timer = setTimeout(resolve, 1500);
        this.send("stop", consumer.id);
        if (this.disposed) resolve();
      }).then(async () => {
        clearTimeout(consumer.timer);
        await consumer.queue;
        if (this.consumer === consumer)
          this.consumer = undefined;
      });
      return consumer.stopping;
    };
    return {
      encodedAudio: this.sender.track?.kind === "audio",
      pause: () => this.send("pause", consumer.id),
      resume: () => {
        if (consumer.stopping || this.consumer !== consumer)
          return;
        this.send("resume", consumer.id);
      },
      stop,
    };
  }

  end(error?: Error): void {
    const consumer = this.consumer;
    if (!consumer || consumer.stopping) return;
    this.send("pause", consumer.id);
    consumer.callbacks.ended(error);
  }

  /** Only the owning connection lifecycle disposes this, never a recording. */
  dispose(): void {
    if (this.disposed) return;
    this.end();
    this.disposed = true;
    this.consumer?.stopped?.();
    this.pc.removeEventListener(
      "connectionstatechange",
      this.connectionChanged,
    );
    this.track?.removeEventListener?.(
      "ended",
      this.trackEnded,
    );
    this.channel.port1.close();
    this.lease.worker.removeEventListener(
      "error",
      this.workerFailed,
    );
    this.lease.release();
  }
}
