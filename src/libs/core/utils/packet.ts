// 创建包含块编号和数据的 ArrayBuffer
export function buildPacket(
  chunkIndex: number,
  blockIndex: number,
  isLastBlock: boolean,
  blockData: ArrayBufferLike,
): ArrayBuffer {
  const headerSize = 4 + 2 + 1; // chunk index (4 bytes) + block index (2 bytes) + is last block (1 byte)

  const packetSize = headerSize + blockData.byteLength;
  const buffer = new ArrayBuffer(packetSize);
  const view = new DataView(buffer);

  // write chunk index (big endian)
  view.setUint32(0, chunkIndex, false);

  // write block index (big endian)
  view.setUint16(4, blockIndex, false);

  // write is last block (1 byte)
  view.setUint8(6, Number(isLastBlock));

  // write data content
  const uint8Packet = new Uint8Array(buffer);
  uint8Packet.set(new Uint8Array(blockData), headerSize);

  return buffer;
}

  // restore ArrayBuffer, get chunk index and block data
export function readPacket(packet: ArrayBuffer): {
  chunkIndex: number;
  blockIndex: number;
  isLastBlock: boolean;
  blockData: Uint8Array;
} {
  const view = new DataView(packet);
  // read chunk index (big endian)
  const chunkNumber = view.getUint32(0, false);

  // read block index (big endian)
  const blockNumber = view.getUint16(4, false);

  // read is last block (1 byte)
  const isLastBlock = view.getUint8(6);

  // extract data content
  const data = new Uint8Array(packet, 7);

  return {
    chunkIndex: chunkNumber,
    blockIndex: blockNumber,
    isLastBlock: Boolean(isLastBlock),
    blockData: data,
  };
}

// convert Blob to ArrayBuffer
export async function blobToArrayBuffer(
  blob: Blob,
): Promise<ArrayBuffer> {
  const fileReader = new FileReader();

  return new Promise((reslove, reject) => {
    fileReader.onloadend = () => {
      reslove(fileReader.result as ArrayBuffer);
    };

    fileReader.onerror = (err) => {
      reject(err);
    };

    fileReader.readAsArrayBuffer(blob);
  });
}
