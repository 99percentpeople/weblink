// Local room_write framing only. Each item is a separate binary SCTP message.
const MAX_BYTES = 256 * 1024;
const MAX_MESSAGES = 32;

export class BinaryWriteBatch {
  private readonly packets: Uint8Array[] = [];
  payloadBytes = 0;

  append(packet: Uint8Array): boolean {
    const count = this.packets.length + 1;
    if (
      !packet.byteLength ||
      count > MAX_MESSAGES ||
      this.payloadBytes + packet.byteLength + 4 * count >
        MAX_BYTES
    )
      return false;
    this.packets.push(packet);
    this.payloadBytes += packet.byteLength;
    return true;
  }

  /** Single packets can use the existing raw IPC without a framing copy. */
  encode(): Uint8Array | undefined {
    if (this.packets.length < 2) return;
    const data = new Uint8Array(
      this.payloadBytes + 4 * this.packets.length,
    );
    const view = new DataView(data.buffer);
    let offset = 0;
    for (const packet of this.packets) {
      view.setUint32(offset, packet.byteLength, true);
      data.set(packet, offset + 4);
      offset += 4 + packet.byteLength;
    }
    return data;
  }
}
