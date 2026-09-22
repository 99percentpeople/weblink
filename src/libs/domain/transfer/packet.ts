export const FILE_TRANSFER_PACKET_HEADER_BYTES = 7;

/**
 * Binary file-transfer block packet.
 *
 * Bytes 0..3: chunk index, uint32 big-endian
 * Bytes 4..5: block index, uint16 big-endian
 * Byte 6:     0 or 1, marks the last block in the compressed chunk
 * Bytes 7..:  block payload
 */
export function buildTransferPacket(
  chunkIndex: number,
  blockIndex: number,
  isLastBlock: boolean,
  blockData: Uint8Array,
): ArrayBuffer {
  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > 0xffffffff
  ) {
    throw new RangeError("chunkIndex must fit uint32");
  }
  if (
    !Number.isInteger(blockIndex) ||
    blockIndex < 0 ||
    blockIndex > 0xffff
  ) {
    throw new RangeError("blockIndex must fit uint16");
  }

  const buffer = new ArrayBuffer(
    FILE_TRANSFER_PACKET_HEADER_BYTES +
      blockData.byteLength,
  );
  const view = new DataView(buffer);

  view.setUint32(0, chunkIndex, false);
  view.setUint16(4, blockIndex, false);
  view.setUint8(6, isLastBlock ? 1 : 0);

  new Uint8Array(buffer).set(
    blockData,
    FILE_TRANSFER_PACKET_HEADER_BYTES,
  );

  return buffer;
}

export interface TransferPacket {
  chunkIndex: number;
  blockIndex: number;
  isLastBlock: boolean;
  blockData: Uint8Array;
}

export function readTransferPacket(
  packet: ArrayBuffer,
): TransferPacket {
  if (
    packet.byteLength < FILE_TRANSFER_PACKET_HEADER_BYTES
  ) {
    throw new Error("Invalid file transfer packet");
  }

  const view = new DataView(packet);
  const lastBlock = view.getUint8(6);
  if (lastBlock !== 0 && lastBlock !== 1) {
    throw new Error("Invalid file transfer packet");
  }

  return {
    chunkIndex: view.getUint32(0, false),
    blockIndex: view.getUint16(4, false),
    isLastBlock: lastBlock === 1,
    blockData: new Uint8Array(
      packet,
      FILE_TRANSFER_PACKET_HEADER_BYTES,
    ),
  };
}
