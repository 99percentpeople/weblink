import { invoke } from "@tauri-apps/api/core";
import { BinaryWriteBatch } from "./write-batch";

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
  private tailBatch?: BinaryWriteBatch;
  private writeFailed = false;
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
  private failWrite(unsent: number) {
    this.writeFailed = true;
    if (this.readyState === "closed") return;
    this.close();
    this.drain(unsent);
    this.dispatchEvent(new Event("error"));
  }
  send(
    data: string | Blob | ArrayBuffer | ArrayBufferView,
  ) {
    if (this.readyState !== "open")
      throw new DOMException(
        "Room channel is not open",
        "InvalidStateError",
      );
    const binary = typeof data !== "string";
    const source = binary
      ? data
      : this.encoder.encode(data);
    const length =
      source instanceof Blob
        ? source.size
        : source.byteLength;
    if (
      length > 16 * 1024 * 1024 ||
      this.bufferedAmount + length > 32 * 1024 * 1024
    )
      throw new DOMException(
        "Room channel send buffer full",
        "OperationError",
      );
    // Snapshot caller-owned buffers only after checking the queue limit.
    const view =
      source instanceof Blob
        ? source
        : ArrayBuffer.isView(source)
          ? new Uint8Array(
              source.buffer,
              source.byteOffset,
              source.byteLength,
            )
          : new Uint8Array(source);
    const payload =
      binary && !(view instanceof Blob)
        ? view.slice()
        : view;
    this.bufferedAmount += length;
    let batch: BinaryWriteBatch | undefined;
    if (
      (this.protocol === "transfer" ||
        this.protocol === "weblink-speedtest-v1") &&
      binary &&
      !(payload instanceof Blob)
    ) {
      if (this.tailBatch?.append(payload)) return;
      const next = new BinaryWriteBatch();
      if (next.append(payload)) batch = next;
    }
    // Only consecutive binary writes can join the tail. Text and Blob are barriers.
    this.tailBatch = batch;
    this.writes = this.writes.then(async () => {
      if (this.tailBatch === batch)
        this.tailBatch = undefined;
      if (this.readyState === "closed") return;
      let unsent = batch?.payloadBytes ?? length;
      if (this.writeFailed) {
        this.drain(unsent);
        return;
      }
      try {
        const frame = batch?.encode();
        const accepted = await invoke<number | null>(
          "room_write",
          frame ??
            (payload instanceof Blob
              ? await payload.arrayBuffer()
              : payload),
          {
            headers: {
              "x-weblink-handle": this.peer,
              "x-channel": String(this.key),
              "x-weblink-payload": frame
                ? "binary-batch"
                : binary
                  ? "binary"
                  : "text",
            },
          },
        );
        if (frame && accepted !== unsent) {
          // Rust can accept a prefix before SCTP closes. Its drain events
          // already own those bytes, and that prefix must never be retried.
          unsent -= accepted ?? 0;
          throw new Error(
            "Incomplete native data channel write",
          );
        }
      } catch {
        this.failWrite(unsent);
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
