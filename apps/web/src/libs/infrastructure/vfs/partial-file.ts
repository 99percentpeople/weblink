import type { ChunkCacheInfo } from "@/libs/domain/file";
import type {
  VfsVolume,
  VfsWrite,
} from "@weblink/platform";
import { isFileFingerprint } from "@/libs/domain/protocol/file-fingerprint";
import { fingerprintBlob } from "../storage/fingerprint";
import { vfsPath } from "@/libs/domain/vfs";

// Payload first: the trailer survives until the final filename has been published.
// Two checksummed metadata slots tolerate a torn update. Chunk digests are always
// rechecked against payload bytes when opening a partial file in a new session.
export const PARTIAL_SLOT_BYTES = 16 * 1024;
export const PARTIAL_CHUNK_BYTES = 36;
export const PARTIAL_SUFFIX = ".part";
const FOOTER_BYTES = 64;
const MAGIC = new TextEncoder().encode("WEBLINK.PART.v1!");
const MARKER = 0x574c5043;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
  (await fingerprintBlob(new Blob([bytes]))).digest;

export interface PartialFinalization {
  source: string;
  target: string;
}
export interface PartialHeader {
  info: ChunkCacheInfo;
  generation: number;
  tableOffset: number;
  metadataOffset: number;
  size: number;
  finalization?: PartialFinalization;
}
export function partialLayout(info: ChunkCacheInfo) {
  const count = Math.ceil(info.fileSize / info.chunkSize!);
  const metadataOffset =
    info.fileSize + count * PARTIAL_CHUNK_BYTES;
  const size =
    metadataOffset + 2 * PARTIAL_SLOT_BYTES + FOOTER_BYTES;
  if (
    !Number.isSafeInteger(info.fileSize) ||
    info.fileSize < 0 ||
    !Number.isSafeInteger(info.chunkSize) ||
    info.chunkSize! < 1 ||
    info.chunkSize! > 0xffffffff ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 0xffffffff ||
    !Number.isSafeInteger(size)
  )
    throw new Error(
      "Partial file exceeds the supported size",
    );
  return {
    count,
    tableOffset: info.fileSize,
    metadataOffset,
    size,
  };
}
export async function metadataSlot(
  info: ChunkCacheInfo,
  generation: number,
  finalization?: PartialFinalization,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > 0xffffffff
  )
    throw new Error("Invalid metadata generation");
  const json = new TextEncoder().encode(
    JSON.stringify({
      ...info,
      _vfsFinalization: finalization,
    }),
  );
  if (json.length > PARTIAL_SLOT_BYTES - 40)
    throw new Error("File metadata is too large");
  const bytes = new Uint8Array(PARTIAL_SLOT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, generation, true);
  view.setUint32(4, json.length, true);
  bytes.set(json, 40);
  const checked = new Uint8Array(8 + json.length);
  checked.set(bytes.subarray(0, 8));
  checked.set(json, 8);
  bytes.set(unhex(await hash(checked)), 8);
  return bytes;
}
export async function createPartial(
  volume: VfsVolume,
  path: string,
  info: ChunkCacheInfo,
) {
  const layout = partialLayout(info);
  const footer = new Uint8Array(FOOTER_BYTES);
  footer.set(MAGIC);
  const view = new DataView(footer.buffer);
  view.setBigUint64(16, BigInt(info.fileSize), true);
  view.setUint32(24, info.chunkSize!, true);
  view.setUint32(28, layout.count, true);
  footer.set(unhex(await hash(footer.slice(0, 32))), 32);
  const metadata = await metadataSlot(
    info,
    1,
    path.endsWith(PARTIAL_SUFFIX)
      ? {
          source: path,
          target: path.slice(0, -PARTIAL_SUFFIX.length),
        }
      : undefined,
  );
  return volume.commit(
    path,
    [
      {
        offset: layout.metadataOffset + PARTIAL_SLOT_BYTES,
        data: metadata,
      },
      { offset: layout.size - FOOTER_BYTES, data: footer },
    ],
    layout.size,
  );
}
async function decodeSlot(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{
  info: ChunkCacheInfo;
  generation: number;
  finalization?: PartialFinalization;
} | null> {
  if (bytes.length !== PARTIAL_SLOT_BYTES) return null;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const generation = view.getUint32(0, true);
  const length = view.getUint32(4, true);
  if (
    !generation ||
    !length ||
    length > PARTIAL_SLOT_BYTES - 40
  )
    return null;
  const checked = new Uint8Array(8 + length);
  checked.set(bytes.subarray(0, 8));
  checked.set(bytes.subarray(40, 40 + length), 8);
  if ((await hash(checked)) !== hex(bytes.subarray(8, 40)))
    return null;
  try {
    const {
      _vfsFinalization: finalization,
      ...info
    }: ChunkCacheInfo & {
      _vfsFinalization?: PartialFinalization;
    } = JSON.parse(
      new TextDecoder().decode(
        bytes.subarray(40, 40 + length),
      ),
    );
    if (
      !info ||
      typeof info.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(info.id) ||
      typeof info.fileName !== "string" ||
      !Number.isSafeInteger(info.fileSize) ||
      info.fileSize < 0 ||
      !Number.isSafeInteger(info.chunkSize) ||
      info.chunkSize! < 1 ||
      (info.fingerprint &&
        (!isFileFingerprint(info.fingerprint) ||
          info.fingerprint.size !== info.fileSize))
    )
      return null;
    if (
      finalization &&
      (typeof finalization.source !== "string" ||
        typeof finalization.target !== "string" ||
        !vfsPath(finalization.source) ||
        !vfsPath(finalization.target) ||
        finalization.source === finalization.target ||
        finalization.source
          .split("/")
          .slice(0, -1)
          .join("/") !==
          finalization.target
            .split("/")
            .slice(0, -1)
            .join("/"))
    )
      return null;
    return { info, generation, finalization };
  } catch {
    return null;
  }
}
export async function readPartialHeader(
  volume: VfsVolume,
  path: string,
  size: number,
): Promise<PartialHeader> {
  if (size < FOOTER_BYTES + 2 * PARTIAL_SLOT_BYTES)
    throw new Error("Partial file trailer is missing");
  const footer = new Uint8Array(
    await volume.read(
      path,
      size - FOOTER_BYTES,
      FOOTER_BYTES,
    ),
  );
  if (
    !MAGIC.every((byte, index) => footer[index] === byte) ||
    (await hash(footer.slice(0, 32))) !==
      hex(footer.subarray(32))
  )
    throw new Error("Partial file trailer is damaged");
  const view = new DataView(footer.buffer);
  const fileSize = Number(view.getBigUint64(16, true));
  const chunkSize = view.getUint32(24, true);
  const layout = partialLayout({
    id: "",
    fileName: "",
    fileSize,
    chunkSize,
  });
  if (
    !chunkSize ||
    layout.size !== size ||
    layout.count !== view.getUint32(28, true)
  )
    throw new Error("Invalid partial file layout");
  const slots = new Uint8Array(
    await volume.read(
      path,
      layout.metadataOffset,
      2 * PARTIAL_SLOT_BYTES,
    ),
  );
  const candidates = await Promise.all([
    decodeSlot(slots.slice(0, PARTIAL_SLOT_BYTES)),
    decodeSlot(slots.slice(PARTIAL_SLOT_BYTES)),
  ]);
  const selected = candidates
    .filter(
      (slot) =>
        slot &&
        slot.info.fileSize === fileSize &&
        slot.info.chunkSize === chunkSize,
    )
    .sort((a, b) => b!.generation - a!.generation)[0];
  if (!selected)
    throw new Error("Partial file metadata is damaged");
  return { ...selected, ...layout };
}
/** Inspect only the footer when listing ordinary files. */
export async function hasPartialTrailer(
  volume: VfsVolume,
  path: string,
  size: number,
): Promise<boolean> {
  if (size < FOOTER_BYTES) return false;
  const footer = new Uint8Array(
    await volume.read(
      path,
      size - FOOTER_BYTES,
      MAGIC.length,
    ),
  );
  return MAGIC.every(
    (byte, index) => footer[index] === byte,
  );
}
export async function readPartialChunks(
  volume: VfsVolume,
  path: string,
  header: PartialHeader,
): Promise<Record<number, string>> {
  const count = Math.ceil(
    header.info.fileSize / header.info.chunkSize!,
  );
  const result: Record<number, string> = {};
  for (let index = 0; index < count; index += 4096) {
    const length = Math.min(4096, count - index);
    const bytes = new Uint8Array(
      await volume.read(
        path,
        header.tableOffset + index * PARTIAL_CHUNK_BYTES,
        length * PARTIAL_CHUNK_BYTES,
      ),
    );
    const view = new DataView(bytes.buffer);
    for (let slot = 0; slot < length; slot++) {
      const offset = slot * PARTIAL_CHUNK_BYTES;
      if (view.getUint32(offset, true) === MARKER)
        result[index + slot] = hex(
          bytes.subarray(
            offset + 4,
            offset + PARTIAL_CHUNK_BYTES,
          ),
        );
    }
  }
  return result;
}
export function chunkCheckpointWrites(
  info: ChunkCacheInfo,
  added: readonly (readonly [number, string])[],
  removed: readonly number[],
): VfsWrite[] {
  const encode = (
    index: number,
    digest?: string,
  ): VfsWrite => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= Math.ceil(info.fileSize / info.chunkSize!)
    )
      throw new Error("Invalid checkpoint index");
    const bytes = new Uint8Array(PARTIAL_CHUNK_BYTES);
    if (digest) {
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new Error("Invalid chunk digest");
      new DataView(bytes.buffer).setUint32(0, MARKER, true);
      bytes.set(unhex(digest), 4);
    }
    return {
      offset: info.fileSize + index * PARTIAL_CHUNK_BYTES,
      data: bytes,
    };
  };
  return [
    ...added.map(([index, digest]) =>
      encode(index, digest),
    ),
    ...removed.map((index) => encode(index)),
  ];
}
