import {
  PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS,
  PEER_SESSION_AUTO_RECONNECT_MAX_DELAY_MS,
  PEER_SESSION_DISCONNECTED_GRACE_MS,
  SIGNALING_CONNECTION_TIMEOUT_MS,
} from "@/constants";
import { catchError } from "@/libs/catch";
import type { SignalingService } from "./signaling";

export type PeerSessionStatus =
  | "created"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "closed"
  | "init";

export interface PeerSessionLifecycleOptions {
  sender: SignalingService;
  polite: boolean;
  clientId(): string;
  getStatus(): PeerSessionStatus;
  setStatus(status: PeerSessionStatus): void;
  getPeerConnection(): RTCPeerConnection | null;
  resetSession(): void;
  disconnect(): void;
  close(): void;
  reconnect(options: { initiate?: boolean }): Promise<void>;
  updateMessageChannelOpenState(): void;
  isMessageChannelReady(): boolean;
  ensureMessageChannelReady(reason: string): Promise<void>;
}

export class PeerSessionLifecycleController {
  private readonly browserController =
    new AbortController();
  private autoReconnectController: AbortController | null =
    null;
  private disconnectionTimer: number | null = null;
  private suspended = false;
  private connectable = false;

  constructor(
    private readonly options: PeerSessionLifecycleOptions,
  ) {
    this.bindBrowserLifecycle();
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  get isConnectable(): boolean {
    return this.connectable;
  }

  markConnectable(): void {
    this.connectable = true;
  }

  private bindBrowserLifecycle(): void {
    const { signal } = this.browserController;

    window.addEventListener(
      "beforeunload",
      () => this.options.close(),
      { signal },
    );

    document.addEventListener(
      "resume",
      () => this.resume("resume"),
      { signal },
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible") return;
        this.resume("visibilitychange");
      },
      { signal },
    );

    window.addEventListener(
      "pageshow",
      () => this.resume("pageshow"),
      { signal },
    );

    window.addEventListener(
      "focus",
      () => this.resume("focus"),
      { signal },
    );

    window.addEventListener(
      "online",
      () => this.resume("online"),
      { signal },
    );

    document.addEventListener(
      "freeze",
      () => {
        if (this.options.getStatus() === "closed") return;
        this.suspended = true;
        this.stopAutoReconnect();
        this.options.disconnect();
      },
      { signal },
    );
  }

  private resume(reason: string): void {
    if (this.options.getStatus() === "closed") return;
    this.suspended = false;
    if (!this.connectable) return;

    const pc = this.options.getPeerConnection();
    if (!pc) {
      void this.handleDisconnection(
        `resume:${reason}:missing-peerconnection`,
      );
      return;
    }

    this.options.updateMessageChannelOpenState();

    if (pc.connectionState !== "connected") {
      void this.handleDisconnection(`resume:${reason}`);
      return;
    }

    if (
      pc.iceConnectionState === "disconnected" ||
      pc.iceConnectionState === "failed"
    ) {
      void this.handleDisconnection(
        `resume:${reason}:ice-${pc.iceConnectionState}`,
      );
      return;
    }

    if (this.options.isMessageChannelReady()) return;

    void this.options
      .ensureMessageChannelReady(`resume:${reason}`)
      .then(() => {
        if (this.options.getStatus() === "closed") return;
        if (
          this.options.getPeerConnection()
            ?.connectionState !== "connected"
        ) {
          return;
        }
        if (this.options.isMessageChannelReady()) return;
        void this.handleDisconnection(
          `resume:${reason}:messagechannel-not-ready`,
        );
      });
  }

  handleConnectionStateChange(pc: RTCPeerConnection): void {
    switch (pc.connectionState) {
      case "new":
        break;
      case "connecting":
        this.options.setStatus("connecting");
        break;
      case "connected":
        this.clearDisconnectionTimer();
        this.markConnectable();
        this.options.setStatus("connected");
        void this.options.ensureMessageChannelReady(
          "connectionstatechange:connected",
        );
        break;
      case "disconnected":
        if (this.disconnectionTimer !== null) return;
        this.disconnectionTimer = window.setTimeout(() => {
          this.disconnectionTimer = null;
          if (pc.connectionState !== "disconnected") return;
          void this.handleDisconnection(
            "connectionstatechange:disconnected",
          );
        }, PEER_SESSION_DISCONNECTED_GRACE_MS);
        break;
      case "failed":
      case "closed":
        void this.handleDisconnection(
          `connectionstatechange:${pc.connectionState}`,
        );
        break;
      default:
        break;
    }
  }

  clearDisconnectionTimer(): void {
    if (this.disconnectionTimer === null) return;
    window.clearTimeout(this.disconnectionTimer);
    this.disconnectionTimer = null;
  }

  stopAutoReconnect(): void {
    const controller = this.autoReconnectController;
    controller?.abort();
    if (this.autoReconnectController === controller) {
      this.autoReconnectController = null;
    }
  }

  async handleDisconnection(
    reason = "unknown",
  ): Promise<void> {
    if (this.options.getStatus() === "closed") {
      console.warn(
        `[PeerSession] session ${this.options.clientId()} is closed, skip handle disconnection`,
      );
      return;
    }

    if (this.suspended) {
      console.log(
        `[PeerSession] session ${this.options.clientId()} is suspended, defer reconnect: ${reason}`,
      );
      return;
    }

    if (this.autoReconnectController) {
      console.log(
        `[PeerSession] auto reconnect already running, skip: ${reason}`,
      );
      return;
    }

    if (!this.connectable) {
      console.warn(
        `[PeerSession] session ${this.options.clientId()} is not connectable, disconnect`,
      );
      this.options.disconnect();
      return;
    }

    const controller = new AbortController();
    this.autoReconnectController = controller;
    this.clearDisconnectionTimer();

    this.options.resetSession();
    this.options.setStatus("reconnecting");

    let attempts = 0;

    while (
      !controller.signal.aborted &&
      attempts < PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS
    ) {
      if (this.options.sender.status === "closed") {
        console.warn(
          "[PeerSession] signaling service is closed, stop reconnect",
        );
        this.options.close();
        return;
      }

      const initiate = !this.options.polite || attempts > 0;
      console.log(
        `[PeerSession] auto reconnect attempt ${attempts + 1}/${PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS} (initiate=${initiate})`,
      );

      if (this.options.sender.status !== "connected") {
        const [signalError] = await catchError(
          this.waitForSignalingConnected(
            controller.signal,
            SIGNALING_CONNECTION_TIMEOUT_MS,
          ),
        );
        if (signalError) {
          console.warn(
            `[PeerSession] wait signaling connected failed: ${signalError.message}`,
          );
        }
      }

      const [error] = await catchError(
        this.options.reconnect({ initiate }),
      );
      if (!error) {
        console.log(
          `[PeerSession] auto reconnect success, session ${this.options.clientId()}`,
        );
        break;
      }

      attempts++;
      console.error(
        `[PeerSession] auto reconnect attempt ${attempts} failed:`,
        error,
      );

      if (
        attempts >= PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS
      ) {
        break;
      }

      await this.delay(
        this.getAutoReconnectDelayMs(attempts),
        controller.signal,
      );
    }

    const ownsReconnect =
      this.autoReconnectController === controller;
    if (ownsReconnect) {
      this.autoReconnectController = null;
    }

    if (controller.signal.aborted || !ownsReconnect) {
      return;
    }

    if (
      this.options.getPeerConnection()?.connectionState !==
      "connected"
    ) {
      console.error(
        "[PeerSession] auto reconnect failed, reach max attempts",
      );
      this.options.disconnect();
    }
  }

  async waitForSignalingConnected(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    const { sender } = this.options;

    if (sender.status === "connected") return;
    if (sender.status === "closed") {
      throw new Error(
        "[PeerSession] signaling service is closed",
      );
    }

    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `[PeerSession] wait signaling connected timeout: after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        controller.abort();
      };

      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(new Error("[PeerSession] aborted"));
        },
        { once: true },
      );

      sender.addEventListener(
        "statuschange",
        (event) => {
          if (event.detail === "connected") {
            cleanup();
            resolve();
            return;
          }

          if (event.detail === "closed") {
            cleanup();
            reject(
              new Error(
                "[PeerSession] signaling service is closed",
              ),
            );
          }
        },
        { signal: controller.signal },
      );
    });
  }

  private getAutoReconnectDelayMs(attempt: number): number {
    const base = 500;
    const exp = Math.round(base * Math.pow(1.7, attempt));
    const capped = Math.min(
      PEER_SESSION_AUTO_RECONNECT_MAX_DELAY_MS,
      exp,
    );
    const jitter = Math.round(Math.random() * 250);
    return capped + jitter;
  }

  private async delay(
    ms: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (ms <= 0) return;

    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  dispose(): void {
    this.browserController.abort();
    this.stopAutoReconnect();
    this.clearDisconnectionTimer();
  }
}
