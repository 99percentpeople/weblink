import type { NativeReceiveData } from "./native-media-receiver";
import {
  CONTROL_CHANNEL,
  POINTER_CHANNEL,
  type ControlDataChannel,
  type RemotePointer,
} from "../domain/remote-control/pointer";
export function screenControlData(
  control: RemotePointer,
): NativeReceiveData {
  const channels = new Map<string, NativeControlChannel>();
  return {
    listen(failed, signal) {
      control.addEventListener(
        "transporterror",
        () =>
          failed(
            new Error("Native control connection ended"),
          ),
        { signal },
      );
    },
    event(event, send) {
      if (event.type === "message") {
        channels.get(event.label)?.dispatchEvent(
          new MessageEvent("message", {
            data: event.data,
          }),
        );
        return;
      }
      if (
        ![CONTROL_CHANNEL, POINTER_CHANNEL].includes(
          event.label,
        )
      )
        return;
      let channel = channels.get(event.label);
      if (!channel) {
        channel = new NativeControlChannel(
          event.label,
          (data) => send(event.label, data),
        );
        channels.set(event.label, channel);
        control.bind(channel);
      }
      channel.state(event.state);
    },
    close() {
      control.close();
      channels.clear();
    },
  };
}

class NativeControlChannel
  extends EventTarget
  implements ControlDataChannel
{
  readonly protocol: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime = null;
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private sending: Promise<void> = Promise.resolve();
  constructor(
    readonly label: string,
    private readonly write: (data: string) => Promise<void>,
  ) {
    super();
    this.protocol = label;
    this.ordered = label === CONTROL_CHANNEL;
    this.maxRetransmits = this.ordered ? null : 0;
  }
  state(state: RTCDataChannelState) {
    if (state === this.readyState) return;
    this.readyState = state;
    if (state === "open" || state === "closed")
      this.dispatchEvent(
        new Event(state === "open" ? "open" : "close"),
      );
  }
  send(data: string) {
    if (this.readyState !== "open")
      throw new Error("Native channel closed");
    const bytes = new TextEncoder().encode(data).byteLength;
    if (this.bufferedAmount + bytes > 65536)
      throw new DOMException(
        "Native channel full",
        "OperationError",
      );
    this.bufferedAmount += bytes;
    // IPC handlers may run concurrently. Serialize submissions so the reliable
    // channel's ordered contract also holds before packets reach SCTP.
    this.sending = this.sending
      .then(() => {
        if (this.readyState === "open")
          return this.write(data);
      })
      .catch(() => {
        if (this.readyState === "open")
          this.dispatchEvent(new Event("error"));
      })
      .finally(() => {
        this.bufferedAmount -= bytes;
        if (
          this.bufferedAmount <=
            this.bufferedAmountLowThreshold &&
          this.readyState === "open"
        )
          this.dispatchEvent(
            new Event("bufferedamountlow"),
          );
      });
  }
  close() {
    this.state("closed");
  }
}
