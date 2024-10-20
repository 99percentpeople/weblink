import { getConfiguration, handleOffer } from "./store";
import { SignalingService } from "./services/type";
import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import { SessionMessage } from "./messge";
import { waitChannel } from "./utils/channel";
import { appOptions } from "@/options";

export interface PeerSessionOptions {
  polite?: boolean;
}

export type PeerSessionEventMap = {
  created: void;
  connecting: void;
  connected: void;
  close: void;
  reconnecting: void;
  channel: RTCDataChannel;
  message: SessionMessage;
  error: Error;
};

export class PeerSession {
  private eventEmitter: MultiEventEmitter<PeerSessionEventMap> =
    new MultiEventEmitter();
  peerConnection: RTCPeerConnection | null = null;
  private makingOffer: boolean = false;
  private ignoreOffer: boolean = false;
  readonly polite: boolean;
  private sender: SignalingService;
  private controller: AbortController =
    new AbortController();

  private channels: RTCDataChannel[] = [];
  private messageChannel: RTCDataChannel | null = null;

  constructor(
    sender: SignalingService,
    { polite = true }: PeerSessionOptions = {},
  ) {
    this.sender = sender;
    this.polite = polite;
  }

  get clientId() {
    return this.sender.clientId;
  }

  get targetClientId() {
    return this.sender.targetClientId;
  }

  get sessionId() {
    return this.sender.sessionId;
  }

  addEventListener<K extends keyof PeerSessionEventMap>(
    eventName: K,
    handler: EventHandler<PeerSessionEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      eventName,
      handler.bind(this),
      options,
    );
  }
  removeEventListener<K extends keyof PeerSessionEventMap>(
    eventName: K,
    handler: EventHandler<PeerSessionEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      eventName,
      handler,
      options,
    );
  }

  private dispatchEvent<
    K extends keyof PeerSessionEventMap,
  >(eventName: K, event: PeerSessionEventMap[K]) {
    return this.eventEmitter.dispatchEvent(
      eventName,
      event,
    );
  }

  private async createConnection() {
    if (this.peerConnection) {
      console.warn(
        `peer connection for session ${this.sessionId} has already been created`,
      );
      return;
    }
    console.log(
      `create peer connection for session ${this.sessionId}`,
    );

    const pc = new RTCPeerConnection(
      await getConfiguration(),
    );

    this.controller.signal.addEventListener(
      "abort",
      () => {
        if (this.peerConnection) {
          this.peerConnection.close();
          this.peerConnection = null;

          this.dispatchEvent("close", undefined);
        }
        this.channels.length = 0;
        this.messageChannel = null;
      },
      { once: true },
    );

    this.peerConnection = pc;
    if (pc.getTransceivers().length === 0) {
      pc.addTransceiver("video", {
        direction: "recvonly",
      });
      pc.addTransceiver("audio", {
        direction: "recvonly",
      });
    }

    this.dispatchEvent("created", undefined);

    pc.addEventListener(
      "icecandidate",
      async (ev: RTCPeerConnectionIceEvent) => {
        if (ev.candidate) {
          console.log(
            `client ${this.clientId} onIcecandidate`,
          );
          this.sender.sendSignal({
            type: "candidate",
            data: JSON.stringify({
              candidate: ev.candidate.toJSON(),
            }),
          });
        }
      },
      {
        signal: this.controller.signal,
      },
    );

    pc.addEventListener(
      "iceconnectionstatechange",
      async () => {
        const state = pc.iceConnectionState;
        switch (state) {
          case "disconnected":
          case "failed":
            console.warn(
              `client ${this.clientId} ICE Connection State: ${state}`,
            );
            break;
          case "connected":
          case "completed":
            console.log(
              `client ${this.clientId} ICE Connection State: ${state}`,
            );
            break;
          default:
            break;
        }
      },
      {
        signal: this.controller.signal,
      },
    );

    pc.addEventListener(
      "datachannel",
      (ev) => {
        this.channels.push(ev.channel);

        ev.channel.addEventListener(
          "close",
          () => {
            const index = this.channels.findIndex(
              (channel) => channel.id === ev.channel.id,
            );
            if (index !== -1) {
              this.channels.splice(index, 1);
            }

            if (ev.channel.label === "message") {
              this.messageChannel = null;
            }
          },

          { once: true },
        );

        if (ev.channel.label === "message") {
          ev.channel.addEventListener(
            "message",
            (ev) => {
              let message = null;
              try {
                message = JSON.parse(
                  ev.data,
                ) as SessionMessage;
                console.log(`get message`, message);
              } catch (err) {
                return;
              }
              this.dispatchEvent("message", message);
            },
            { signal: this.controller.signal },
          );

          this.messageChannel = ev.channel;
        }

        this.dispatchEvent("channel", ev.channel);
      },
      {
        signal: this.controller.signal,
      },
    );

    pc.addEventListener(
      "signalingstatechange",
      () => {
        console.log(
          `${this.clientId} current signalingstatechange state is ${pc.signalingState}`,
        );
      },
      {
        signal: this.controller.signal,
      },
    );

    pc.addEventListener(
      "negotiationneeded",
      async () => {
        console.log(
          `client ${this.clientId} onNegotiationneeded`,
        );
        await this.renegotiate();
      },
      { signal: this.controller.signal },
    );

    pc.addEventListener(
      "connectionstatechange",
      () => {
        switch (pc.connectionState) {
          case "new":
            break;
          case "connecting":
            console.log(`${this.clientId} is connecting`);
            this.dispatchEvent("connecting", undefined);
            break;
          case "connected":
            console.log(
              `${this.clientId} connection established`,
            );
            this.dispatchEvent("connected", undefined);

            this.createChannel("message");

            break;
          case "failed":
          case "closed":
          case "disconnected":
            console.warn(
              `${this.clientId} connection error state: ${pc.connectionState}`,
            );
            this.destory();
            break;
          default:
            break;
        }
      },
      { signal: this.controller.signal },
    );

    return pc;
  }

  async listen() {
    const pc = await this.createConnection();
    if (!pc) {
      return;
    }
    this.sender.listenForSignal(async (signal) => {
      console.log(
        `client received signal with type ${signal.type}`,
      );

      try {
        const data = JSON.parse(signal.data);
        if (signal.type === "offer") {
          const offerCollision =
            this.makingOffer ||
            pc.signalingState !== "stable";
          this.ignoreOffer = !this.polite && offerCollision;
          if (this.ignoreOffer) {
            console.log("Offer ignored due to collision");
            return;
          }

          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: "offer",
              sdp: data.sdp,
            }),
          );

          await pc.setLocalDescription();
          if (pc.localDescription)
            this.sender.sendSignal({
              type: pc.localDescription.type,
              data: JSON.stringify({
                sdp: pc.localDescription.sdp,
              }),
            });
        } else if (signal.type === "answer") {
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: "answer",
              sdp: data.sdp,
            }),
          );
        } else if (signal.type === "candidate") {
          const candidate = new RTCIceCandidate(
            data.candidate,
          );
          await pc
            .addIceCandidate(candidate)
            .catch((err) => {
              if (!this.ignoreOffer) throw err;
            });
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  async createChannel(label: string) {
    if (!this.peerConnection) {
      console.error(
        `failed to create channel, peer connection is null`,
      );
      return;
    }
    const channel = this.peerConnection.createDataChannel(
      label,
      {
        ordered: appOptions.ordered,
      },
    );

    this.channels.push(channel);

    channel.addEventListener(
      "close",
      () => {
        const index = this.channels.findIndex(
          (channel) => channel.id === channel.id,
        );
        if (index !== -1) {
          this.channels.splice(index, 1);
        }

        if (channel.label === "message") {
          this.messageChannel = null;
        }
      },

      { once: true },
    );

    if (channel.label === "message") {
      channel.addEventListener(
        "message",
        (ev) => {
          let message = null;
          try {
            message = JSON.parse(ev.data) as SessionMessage;
            console.log(`get message`, message);
          } catch (err) {
            return;
          }
          this.dispatchEvent("message", message);
        },
        { signal: this.controller.signal },
      );

      this.messageChannel = channel;
    }

    await waitChannel(channel);
    return channel;
  }

  sendMessage(message: SessionMessage) {
    if (!this.messageChannel) {
      console.error(
        `failed to send message, peer connection is null`,
      );
      return;
    }

    this.messageChannel.send(JSON.stringify(message));
  }

  async renegotiate() {
    if (!this.peerConnection) {
      console.warn(
        `renegotiate调用必须已经初始化peerConnection`,
      );
      return;
    }

    if (this.peerConnection.signalingState === "closed") {
      console.warn(
        `renegotiate error peerConnection connectionState is "closed"`,
      );
      return;
    }
    if (!this.makingOffer) {
      this.makingOffer = true;
      await handleOffer(this.peerConnection, this.sender)
        .catch((err) => {
          console.error(err);
        })
        .finally(() => {
          this.makingOffer = false;
        });
    }
  }

  async reconnect() {
    this.dispatchEvent("reconnecting", undefined);
    if (this.peerConnection) {
      const pc = this.peerConnection;
      if (pc.connectionState === "connected") return;

      return new Promise<void>(async (resolve, reject) => {
        const onConnectionStateChange = () => {
          switch (pc.connectionState) {
            case "connected":
              pc.removeEventListener(
                "connectionstatechange",
                onConnectionStateChange,
              );
              resolve();
              break;
            case "failed":
            case "closed":
            case "disconnected":
              pc.removeEventListener(
                "connectionstatechange",
                onConnectionStateChange,
              );
              this.dispatchEvent(
                "error",
                Error("reconnect error"),
              );
              this.destory();
              reject(
                new Error(
                  `Connection failed with state: ${pc.connectionState}`,
                ),
              );
              break;
            default:
              console.log(
                `connectionstatechange state: ${pc.connectionState}`,
              );
              break;
          }
        };

        pc.addEventListener(
          "connectionstatechange",
          onConnectionStateChange,
          { signal: this.controller.signal },
        );

        pc.restartIce();

        this.makingOffer = true;
        await handleOffer(pc, this.sender)
          .catch((err) => {
            console.error("Error during ICE restart:", err);
          })
          .finally(() => {
            this.makingOffer = false;
          });
      });
    } else {
      return await this.connect();
    }
  }

  async connect() {
    const pc = this.peerConnection;
    if (!pc) {
      console.warn(`listen failed`);

      return;
    }

    if (pc.connectionState === "connected") {
      console.warn(
        `session ${this.sessionId} already connected`,
      );

      return;
    }

    return new Promise<void>(async (resolve, reject) => {
      const onConnectionStateChange = () => {
        switch (pc.connectionState) {
          case "connected":
            pc.removeEventListener(
              "connectionstatechange",
              onConnectionStateChange,
            );
            resolve();
            break;
          case "failed":
          case "closed":
          case "disconnected":
            pc.removeEventListener(
              "connectionstatechange",
              onConnectionStateChange,
            );
            this.destory();
            reject(
              new Error(
                `Connection failed with state: ${pc.connectionState}`,
              ),
            );
            break;
          default:
            // 其他状态不做处理
            break;
        }
      };

      pc.addEventListener(
        "connectionstatechange",
        onConnectionStateChange,
        { signal: this.controller.signal },
      );

      this.makingOffer = true;
      await handleOffer(pc, this.sender)
        .catch((err) => {
          reject(
            new Error(
              `Failed to create and send offer: ${err.message}`,
            ),
          );
        })
        .finally(() => {
          this.makingOffer = false;
        });
    });
  }

  destory() {
    this.controller.abort();
  }
}
