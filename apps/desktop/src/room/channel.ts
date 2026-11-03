import { invoke } from "@tauri-apps/api/core";

/** The WebView owns event dispatch and outbound IPC buffering. SCTP stays on the room peer. */
export class RoomDataChannel
  extends EventTarget
  implements RTCDataChannel
{
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";
  id: number | null = null;
  readonly negotiated = false;
  readonly ordered: boolean;
  readonly protocol: string;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  onbufferedamountlow: RTCDataChannel["onbufferedamountlow"] =
    null;
  onclose: RTCDataChannel["onclose"] = null;
  onclosing: RTCDataChannel["onclosing"] = null;
  onerror: RTCDataChannel["onerror"] = null;
  onmessage: RTCDataChannel["onmessage"] = null;
  onopen: RTCDataChannel["onopen"] = null;
  private writes = Promise.resolve();
  private readonly encoder = new TextEncoder();
  constructor(
    private readonly peer: string,
    readonly key: number,
    readonly label: string,
    options: RTCDataChannelInit,
    private readonly end: () => void,
  ) {
    super();
    this.protocol = options.protocol ?? "";
    this.ordered = options.ordered ?? true;
    this.maxPacketLifeTime =
      options.maxPacketLifeTime ?? null;
    this.maxRetransmits = options.maxRetransmits ?? null;
    for (const name of [
      "open",
      "closing",
      "close",
      "bufferedamountlow",
    ] as const) {
      this.addEventListener(name, (event) =>
        this[`on${name}`]?.call(this, event),
      );
    }
    this.addEventListener("message", (event) =>
      this.onmessage?.call(this, event as MessageEvent),
    );
    this.addEventListener("error", (event) =>
      this.onerror?.call(this, event as RTCErrorEvent),
    );
  }
  state(state: RTCDataChannelState, id?: number) {
    if (id !== undefined && id >= 0) this.id = id;
    if (
      this.readyState === "closed" ||
      state === this.readyState ||
      (this.readyState === "closing" && state !== "closed")
    )
      return;
    this.readyState = state;
    if (state !== "connecting")
      this.dispatchEvent(
        new Event(state === "closed" ? "close" : state),
      );
  }
  drain(bytes: number) {
    const before = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, before - bytes);
    if (
      before > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    )
      this.dispatchEvent(new Event("bufferedamountlow"));
  }
  receive(bytes: Uint8Array<ArrayBuffer>, binary: boolean) {
    if (this.readyState === "closed") return;
    const data = !binary
      ? new TextDecoder().decode(bytes)
      : this.binaryType === "blob"
        ? new Blob([bytes])
        : bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
    this.dispatchEvent(
      new MessageEvent("message", { data }),
    );
  }
  send(
    data: string | Blob | ArrayBuffer | ArrayBufferView,
  ) {
    if (this.readyState !== "open")
      throw new DOMException(
        "Room channel is not open",
        "InvalidStateError",
      );
    const payload =
      typeof data === "string"
        ? this.encoder.encode(data)
        : data instanceof Blob
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data.slice(0))
            : new Uint8Array(
                data.buffer,
                data.byteOffset,
                data.byteLength,
              ).slice();
    const length =
      payload instanceof Blob
        ? payload.size
        : payload.byteLength;
    if (
      length > 16 * 1024 * 1024 ||
      this.bufferedAmount + length > 32 * 1024 * 1024
    )
      throw new DOMException(
        "Room channel send buffer full",
        "OperationError",
      );
    this.bufferedAmount += length;
    this.writes = this.writes
      .then(async () => {
        if (this.readyState === "closed") return;
        await invoke(
          "room_write",
          payload instanceof Blob
            ? await payload.arrayBuffer()
            : payload,
          {
            headers: {
              "x-weblink-handle": this.peer,
              "x-channel": String(this.key),
              "x-weblink-payload":
                typeof data === "string"
                  ? "text"
                  : "binary",
            },
          },
        );
      })
      .catch(() => {
        this.drain(length);
        if (this.readyState !== "closed") {
          this.dispatchEvent(new Event("error"));
          this.close();
        }
      });
  }
  close() {
    if (
      this.readyState === "closed" ||
      this.readyState === "closing"
    )
      return;
    this.state("closing");
    void this.writes.then(this.end);
  }
}
