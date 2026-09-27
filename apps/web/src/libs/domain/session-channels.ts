import { catchError, catchErrorSync } from "@/libs/catch";
import type { SessionMessage } from "./protocol/messages";
import {
  type MessageSendOptions,
  RtcProtocolError,
} from "./protocol/errors";
import { MessageSendQueue } from "./session-send-queue";
import { parseSessionMessage } from "./protocol/validation";
import { waitChannel } from "./utils/channel";
import type { PeerSessionStatus } from "./session-lifecycle";

export interface PeerSessionChannelOptions {
  polite: boolean;
  getStatus(): PeerSessionStatus;
  getPeerConnection(): RTCPeerConnection | null;
  getSessionSignal(): AbortSignal | undefined;
  ordered(): boolean;
  createChannel(
    label: string,
    protocol: string,
  ): Promise<RTCDataChannel>;
  onChannel(channel: RTCDataChannel): void;
  onMessage(message: SessionMessage): void;
  onMessageChannelChange(state: "ready" | "closed"): void;
}

export class PeerSessionChannelController {
  private readonly channels: RTCDataChannel[] = [];
  private messageChannel: RTCDataChannel | null = null;
  private messageChannelOpen = false;
  private readonly messageChannelSetups =
    new WeakSet<RTCDataChannel>();
  private readonly readyWaiters = new Set<() => void>();
  private readonly messageSendQueue = new MessageSendQueue(
    () => this.getOpenMessageChannel(),
  );
  private ensureMessageChannelPromise: Promise<void> | null =
    null;

  constructor(
    private readonly options: PeerSessionChannelOptions,
  ) {}

  get isMessageChannelReady(): boolean {
    return this.messageChannelOpen;
  }

  get pendingMessageCount(): number {
    return this.messageSendQueue.size;
  }

  acceptIncomingChannel(channel: RTCDataChannel): void {
    this.trackChannel(channel);

    if (channel.protocol === "message") {
      this.setupMessageChannel(channel);
    }

    this.options.onChannel(channel);
  }

  private trackChannel(channel: RTCDataChannel): void {
    if (!this.channels.includes(channel)) {
      this.channels.push(channel);
    }

    channel.addEventListener(
      "close",
      () => {
        const index = this.channels.findIndex(
          // SCTP IDs are reused by the replacement RTCPeerConnection. A late
          // close event from the old channel must not remove the new one.
          (candidate) => candidate === channel,
        );
        if (index !== -1) {
          this.channels.splice(index, 1);
        }
      },
      { once: true },
    );
  }

  updateMessageChannelOpenState(): void {
    const isOpen = this.channels.some(
      (channel) =>
        channel.protocol === "message" &&
        channel.readyState === "open",
    );

    if (this.messageChannelOpen === isOpen) return;
    this.messageChannelOpen = isOpen;
    this.options.onMessageChannelChange(
      isOpen ? "ready" : "closed",
    );

    if (isOpen) {
      for (const resolve of this.readyWaiters) resolve();
      this.readyWaiters.clear();
    }
  }

  private getOpenMessageChannel(): RTCDataChannel | null {
    if (this.messageChannel?.readyState === "open") {
      return this.messageChannel;
    }

    const open = this.channels.find(
      (channel) =>
        channel.protocol === "message" &&
        channel.readyState === "open",
    );
    if (open) this.messageChannel = open;
    return open ?? null;
  }

  private hasConnectingMessageChannel(): boolean {
    return this.channels.some(
      (channel) =>
        channel.protocol === "message" &&
        channel.readyState === "connecting",
    );
  }

  private flushOutgoingQueue(): void {
    this.messageSendQueue.flush();
  }

  private waitForMessageChannelReady(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    if (this.getOpenMessageChannel()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.readyWaiters.delete(onReady);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => finish();
      const onAbort = () =>
        finish(new Error("[PeerSession] aborted"));
      const timer = window.setTimeout(
        () =>
          finish(
            new Error(
              `[PeerSession] wait message channel timeout: after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );

      if (signal.aborted) {
        finish(new Error("[PeerSession] aborted"));
        return;
      }

      this.readyWaiters.add(onReady);
      signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });
  }

  ensureMessageChannelReady(reason: string): Promise<void> {
    if (this.ensureMessageChannelPromise) {
      return this.ensureMessageChannelPromise;
    }

    const pc = this.options.getPeerConnection();
    const signal = this.options.getSessionSignal();
    if (!pc || !signal) return Promise.resolve();

    const isCurrent = () =>
      !signal.aborted &&
      this.options.getPeerConnection() === pc;
    const promise = (async () => {
      if (!isCurrent()) return;
      if (this.options.getStatus() === "closed") return;
      if (pc.connectionState !== "connected") return;

      if (this.getOpenMessageChannel()) {
        this.flushOutgoingQueue();
        return;
      }

      if (
        this.hasConnectingMessageChannel() ||
        this.messageChannel
      ) {
        const [waitError] = await catchError(
          this.waitForMessageChannelReady(signal, 3500),
        );
        if (!waitError) {
          this.flushOutgoingQueue();
          return;
        }
      } else if (this.options.polite) {
        const [waitError] = await catchError(
          this.waitForMessageChannelReady(signal, 5000),
        );
        if (!waitError) {
          this.flushOutgoingQueue();
          return;
        }
      }

      if (!isCurrent()) return;
      const [createError] = await catchError(
        this.options.createChannel("message", "message"),
      );
      if (createError) {
        if (!isCurrent()) {
          console.debug(
            `[PeerSession] message channel recovery interrupted (${reason})`,
            createError,
          );
        } else {
          console.warn(
            `[PeerSession] ensure message channel failed (${reason})`,
            createError,
          );
        }
        return;
      }

      if (isCurrent()) this.flushOutgoingQueue();
    })().finally(() => {
      if (this.ensureMessageChannelPromise === promise)
        this.ensureMessageChannelPromise = null;
    });
    this.ensureMessageChannelPromise = promise;

    return promise;
  }

  async createChannel(
    label: string,
    protocol: string,
  ): Promise<RTCDataChannel> {
    const pc = this.options.getPeerConnection();
    if (!pc) {
      throw new Error(
        "[PeerSession] failed to create channel, peer connection is null",
      );
    }

    const matches = this.channels.filter(
      (channel) =>
        channel.label === label &&
        channel.protocol === protocol,
    );

    const preferred =
      protocol === "message" &&
      this.messageChannel &&
      this.messageChannel.label === label &&
      this.messageChannel.protocol === protocol &&
      !["closing", "closed"].includes(
        this.messageChannel.readyState,
      )
        ? this.messageChannel
        : null;

    if (preferred?.readyState === "open") {
      return preferred;
    }

    if (preferred?.readyState === "connecting") {
      const [waitError] = await catchError(
        waitChannel(preferred),
      );
      if (!waitError) return preferred;
    }

    const openChannel = matches.find(
      (channel) => channel.readyState === "open",
    );
    if (openChannel) {
      if (
        protocol === "message" &&
        this.messageChannel !== openChannel
      ) {
        this.setupMessageChannel(openChannel);
      }
      return openChannel;
    }

    const connectingChannel = matches.find(
      (channel) => channel.readyState === "connecting",
    );
    if (connectingChannel) {
      if (
        protocol === "message" &&
        this.messageChannel !== connectingChannel
      ) {
        this.setupMessageChannel(connectingChannel);
      }

      const [waitError] = await catchError(
        waitChannel(connectingChannel),
      );
      if (!waitError) return connectingChannel;
    }

    const channel = pc.createDataChannel(label, {
      ordered: this.options.ordered(),
      protocol,
    });
    this.trackChannel(channel);

    if (channel.protocol === "message") {
      this.setupMessageChannel(channel);
    }

    await waitChannel(channel);
    return channel;
  }

  private setupMessageChannel(
    channel: RTCDataChannel,
  ): void {
    if (channel.protocol !== "message") return;

    if (!this.messageChannel) {
      this.messageChannel = channel;
    }

    if (this.messageChannelSetups.has(channel)) {
      if (channel.readyState === "open") {
        this.messageChannel = channel;
        this.updateMessageChannelOpenState();
        this.flushOutgoingQueue();
      }
      return;
    }

    this.messageChannelSetups.add(channel);
    const signal = this.options.getSessionSignal();

    channel.addEventListener(
      "message",
      (event) => {
        const [error, message] = catchErrorSync(() =>
          parseSessionMessage(event.data),
        );
        if (error) {
          console.warn(
            "[PeerSession] invalid message received; ignoring",
            { channelId: channel.id },
            error,
          );
          return;
        }
        this.options.onMessage(message);
      },
      { signal },
    );

    channel.addEventListener(
      "open",
      () => {
        this.messageChannel = channel;
        this.updateMessageChannelOpenState();
        this.flushOutgoingQueue();
      },
      { signal },
    );

    channel.addEventListener(
      "error",
      (event) => {
        if (signal?.aborted) return;
        console.warn(
          "[PeerSession] message channel error",
          {
            channelId: channel.id,
            state: channel.readyState,
          },
          event,
        );
      },
      { signal },
    );

    channel.addEventListener(
      "close",
      () => {
        if (this.messageChannel === channel) {
          this.messageChannel = null;
          this.messageChannel =
            this.getOpenMessageChannel();
        }

        this.updateMessageChannelOpenState();

        if (!this.messageChannelOpen) {
          void this.ensureMessageChannelReady(
            "messagechannelchange:closed",
          );
        }
      },
      { signal },
    );

    if (channel.readyState === "open") {
      this.messageChannel = channel;
      this.updateMessageChannelOpenState();
      this.flushOutgoingQueue();
    }
  }

  sendMessage(
    message: SessionMessage,
    options: MessageSendOptions = {},
  ): Promise<void> {
    if (this.options.getStatus() === "closed") {
      return Promise.reject(new RtcProtocolError("closed"));
    }

    const pending = this.messageSendQueue.send(
      message,
      options,
    );

    if (this.messageSendQueue.size > 0) {
      void this.ensureMessageChannelReady(
        `sendMessage:${message.type}`,
      ).catch((error) => {
        console.warn(
          "[PeerSession] message channel recovery failed",
          error,
        );
      });
    }

    return pending;
  }

  reset(): void {
    this.ensureMessageChannelPromise = null;

    for (const channel of this.channels) {
      channel.close();
    }
    this.channels.length = 0;

    if (this.messageChannel) {
      this.messageChannel.close();
      this.messageChannel = null;
    }

    this.readyWaiters.clear();
    this.updateMessageChannelOpenState();
  }

  close(): void {
    this.reset();
    this.messageSendQueue.close();
  }
}
