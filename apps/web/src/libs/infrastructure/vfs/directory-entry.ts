import type {
  StoredFile,
  VfsStat,
  VfsVolumeInfo,
} from "@weblink/platform";
import type { StoredVfsFile } from "./database";
import { fingerprintBlob } from "../storage/fingerprint";
import { decodeDirectoryFilename } from "./directory-filename";
export const RECORDING_SUFFIX = ".recording.part";

/** A completed file's identity is reconstructed from its directory entry. */
export async function directoryEntry(
  volume: VfsVolumeInfo,
  path: string,
  stat: VfsStat,
  file: StoredFile,
): Promise<StoredVfsFile> {
  const mountId = volume.id;
  const name = path.split("/").at(-1)!;
  const draft = name.endsWith(RECORDING_SUFFIX);
  // Keep the protective disk suffix and session token out of the catalog name,
  // including when an interrupted draft is reconstructed after a restart.
  const fileName = draft
    ? name
        .slice(0, -RECORDING_SUFFIX.length)
        .replace(
          /\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
          "",
        )
    : volume.kind === "directory"
      ? decodeDirectoryFilename(name)
      : name;
  const id = `directory_${(await fingerprintBlob(new Blob([JSON.stringify([mountId, path, draft ? "recording" : stat.revision])]))).digest}`;
  return {
    id,
    mountId,
    path,
    info: {
      id,
      fileName,
      fileSize: stat.size,
      lastModified: stat.modified,
      mimetype: file.type,
      chunkSize: 256 * 1024,
      libraryPinned: true,
      createdAt: stat.modified,
    },
    complete: !draft,
    draft: draft ? "recording" : undefined,
    chunks: {},
    revision: stat.revision,
    source: "directory",
    present: true,
    verifyContent: true,
  };
}
