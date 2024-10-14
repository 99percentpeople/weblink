// 创建包含块编号和数据的 ArrayBuffer
export function buildPacket(
  chunkIndex: number,
  blockIndex: number,
  isLastBlock: boolean,
  blockData: ArrayBufferLike,
): ArrayBuffer {
  const headerSize = 4 + 2 + 1; // 区块编号（4字节）+ 块编号（2字节）+ 是否为最后一个块（1字节）

  const packetSize = headerSize + blockData.byteLength;
  const buffer = new ArrayBuffer(packetSize);
  const view = new DataView(buffer);

  // 写入区块编号（大端序）
  view.setUint32(0, chunkIndex, false);

  // 写入块编号（大端序）
  view.setUint16(4, blockIndex, false);

  // 写入是否为最后一个块
  view.setUint8(6, Number(isLastBlock));

  // 写入数据内容
  const uint8Packet = new Uint8Array(buffer);
  uint8Packet.set(new Uint8Array(blockData), headerSize);

  return buffer;
}

// 还原 ArrayBuffer，获取编号和原始数据
export function readPacket(packet: ArrayBuffer): {
  chunkIndex: number;
  blockIndex: number;
  isLastBlock: boolean;
  blockData: Uint8Array;
} {
  const view = new DataView(packet);
  // 读取区块编号（大端序）
  const chunkNumber = view.getUint32(0, false);

  // 读取块编号（大端序）
  const blockNumber = view.getUint16(4, false);

  // 读取是否为最后一个块
  const isLastBlock = view.getUint8(6);

  // 提取数据内容
  const data = new Uint8Array(packet, 7);

  return {
    chunkIndex: chunkNumber,
    blockIndex: blockNumber,
    isLastBlock: Boolean(isLastBlock),
    blockData: data,
  };
}

// 将 Blob 转换为 ArrayBuffer
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
