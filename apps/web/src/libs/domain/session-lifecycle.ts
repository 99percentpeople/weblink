import { PEER_SESSION_DISCONNECTED_GRACE_MS } from "@/constants";
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
  getStatus(): PeerSessionStatus;
  setStatus(status: PeerSessionStatus): void;
  getPeerConnection(): RTCPeerConnection | null;
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
  private recoveryController: AbortController | null = null;
  private pendingAvailability: string | null = null;
  private disconnectionTimer: number | null = null;
  private suspended = false;
  private connectable = false;
  private listening = false;

  constructor(
    private readonly options: PeerSessionLifecycleOptions,
  ) {
    this.bindBrowserLifecycle();
    let signalingStatus = options.sender.status;
    options.sender.addEventListener(
      "statuschange",
      ({ detail }) => {
        if (detail === signalingStatus) return;
        signalingStatus = detail;
        if (detail !== "connected") return;
        // Room acknowledgement/replay completes before evaluating availability.
        queueMicrotask(() =>
          this.resume("signaling-connected"),
        );
      },
      { signal: this.browserController.signal },
    );
    options.sender.addEventListener(
      "peeravailable",
      () => this.resume("peer-online"),
      { signal: this.browserController.signal },
    );
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

  markListening(): void {
    this.listening = true;
  }

  private bindBrowserLifecycle(): void {
    const { signal } = this.browserController;
    window.addEventListener(
      "beforeunload",
      () => this.options.close(),
      { signal },
    );
    // Focus/tab switches are not evidence of renewed network availability.
    // Only a real page suspension/resume, network-online or signaling event
    // can request another attempt after failure.
    const resumePage = () => {
      if (!this.suspended) return;
      this.suspended = false;
      this.resume("resume");
    };
    document.addEventListener("resume", resumePage, {
      signal,
    });
    window.addEventListener("pageshow", resumePage, {
      signal,
    });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible")
          resumePage();
      },
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
        this.stopRecovery();
        this.clearDisconnectionTimer();
        this.options.disconnect();
      },
      { signal },
    );
  }

  private resume(reason: string): void {
    if (
      this.browserController.signal.aborted ||
      this.suspended ||
      this.options.getStatus() === "closed" ||
      (!this.connectable && !this.listening)
    )
      return;

    const pc = this.options.getPeerConnection();
    if (
      pc?.connectionState === "connected" &&
      pc.iceConnectionState !== "disconnected" &&
      pc.iceConnectionState !== "failed"
    ) {
      this.options.updateMessageChannelOpenState();
      if (this.options.isMessageChannelReady()) return;
      void this.options
        .ensureMessageChannelReady(`resume:${reason}`)
        .then(() => {
          if (
            this.browserController.signal.aborted ||
            this.options.getPeerConnection() !== pc ||
            pc.connectionState !== "connected" ||
            this.options.isMessageChannelReady()
          )
            return;
          void this.handleDisconnection(
            `resume:${reason}:messagechannel-not-ready`,
          );
        });
      return;
    }

    // A genuinely new availability event must not get lost behind a timed-out
    // attempt. Coalesce these events, not failure callbacks; no retry timer.
    if (this.recoveryController) {
      this.pendingAvailability = reason;
      return;
    }
    // An incoming offer/initial connection already owns the current attempt.
    if (pc?.connectionState === "connecting") return;
    void this.handleDisconnection(
      `resume:${reason}${pc ? "" : ":missing-peerconnection"}`,
    );
  }

  handleConnectionStateChange(pc: RTCPeerConnection): void {
    if (pc !== this.options.getPeerConnection()) return;
    switch (pc.connectionState) {
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
          if (
            pc !== this.options.getPeerConnection() ||
            pc.connectionState !== "disconnected"
          )
            return;
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
    }
  }

  clearDisconnectionTimer(): void {
    if (this.disconnectionTimer === null) return;
    window.clearTimeout(this.disconnectionTimer);
    this.disconnectionTimer = null;
  }

  stopRecovery(): void {
    this.recoveryController?.abort();
    this.recoveryController = null;
    this.pendingAvailability = null;
  }

  async handleDisconnection(
    reason = "unknown",
  ): Promise<void> {
    if (
      this.browserController.signal.aborted ||
      this.options.getStatus() === "closed" ||
      this.suspended ||
      this.recoveryController
    )
      return;
    this.clearDisconnectionTimer();
    if (this.options.sender.status === "closed") {
      this.options.close();
      return;
    }
    if (
      (!this.connectable && !this.listening) ||
      this.options.sender.status !== "connected"
    ) {
      // Passive while signaling is unavailable: its connected event wakes us.
      // Do not allocate a PC or repeatedly wait on signaling with timeouts.
      this.options.disconnect();
      return;
    }

    const controller = new AbortController();
    this.recoveryController = controller;
    this.options.setStatus("reconnecting");
    console.info("[PeerSession] recovery started", {
      clientId: this.options.sender.clientId,
      peerId: this.options.sender.targetClientId,
      reason,
    });
    try {
      // Automatic recovery keeps one deterministic offer owner. The impolite
      // peer initiates; the polite peer rebuilds and waits for that offer.
      await this.options.reconnect({
        initiate: !this.options.polite,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.recoveryController !== controller
      )
        return;
      console.warn(
        "[PeerSession] recovery failed; waiting for an availability event",
        {
          clientId: this.options.sender.clientId,
          peerId: this.options.sender.targetClientId,
          reason,
        },
        error,
      );
      this.options.disconnect();
    } finally {
      if (this.recoveryController === controller) {
        this.recoveryController = null;
        const pending = this.pendingAvailability;
        this.pendingAvailability = null;
        if (pending && !controller.signal.aborted)
          this.resume(pending);
      }
    }
  }

  async waitForSignalingConnected(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    const { sender } = this.options;
    if (signal.aborted)
      throw new DOMException(
        "Signaling wait aborted",
        "AbortError",
      );
    if (sender.status === "connected") return;
    if (sender.status === "closed")
      throw new Error(
        "[PeerSession] signaling service is closed",
      );
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
        { once: true, signal: controller.signal },
      );
      sender.addEventListener(
        "statuschange",
        ({ detail }) => {
          if (detail === "connected") {
            cleanup();
            resolve();
          } else if (detail === "closed") {
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

  dispose(): void {
    this.browserController.abort();
    this.stopRecovery();
    this.clearDisconnectionTimer();
  }
}
