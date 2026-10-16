import type {
  StoredFile,
  VfsStat,
  VfsVolumeInfo,
} from "@weblink/platform";
import type { StoredVfsFile } from "./database";
import { fingerprintBlob } from "../storage/fingerprint";
import { decodeDirectoryFilename } from "./directory-filename";

/** A completed file's identity is reconstructed from its directory entry. */
export async function directoryEntry(
  volume: VfsVolumeInfo,
  path: string,
  stat: VfsStat,
  file: StoredFile,
): Promise<StoredVfsFile> {
  const mountId = volume.id;
  const name = path.split("/").at(-1)!;
  const id = `directory_${(await fingerprintBlob(new Blob([JSON.stringify([mountId, path, stat.revision])]))).digest}`;
  return {
    id,
    mountId,
    path,
    info: {
      id,
      fileName:
        volume.kind === "directory"
          ? decodeDirectoryFilename(name)
          : name,
      fileSize: stat.size,
      lastModified: stat.modified,
      mimetype: file.type,
      chunkSize: 256 * 1024,
      libraryPinned: true,
      createdAt: stat.modified,
    },
    complete: true,
    chunks: {},
    revision: stat.revision,
    source: "directory",
    present: true,
    verifyContent: true,
  };
}
