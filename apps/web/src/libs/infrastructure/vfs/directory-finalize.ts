import type { VfsStat, VfsVolume } from "@weblink/platform";
import { StorageUnavailableError } from "@/libs/domain/vfs";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";
import type { FileWriteOptions } from "@/libs/domain/file";
import type { DirectoryVerification } from "./directory-verification";
import type { StoredVfsFile } from "./database";
import {
  decodeDirectoryFilename,
  encodeDirectoryFilename,
  isDirectoryNameBlocked,
} from "./directory-filename";
import {
  metadataSlot,
  PARTIAL_SLOT_BYTES,
  PARTIAL_SUFFIX,
  readPartialHeader,
  type PartialHeader,
} from "./partial-file";

/** Keep recovery metadata until the final destination is committed and the source removed. */
export async function finalizeDirectoryFile(
  volume: VfsVolume,
  record: StoredVfsFile,
  header: PartialHeader,
  moved: () => void,
  verification: DirectoryVerification,
  verifiedStat: VfsStat,
  fingerprint: FileFingerprint,
  options: FileWriteOptions = {},
): Promise<VfsStat> {
  const info = record.info!;
  const initialPath = record.path;
  let sourceRevision = verifiedStat.revision;
  const checkVersion = async (
    path: string,
    revision: string,
  ) => {
    options.signal?.throwIfAborted();
    if ((await volume.stat(path))?.revision !== revision)
      throw new StorageUnavailableError(
        "File changed while publishing completion",
      );
  };
  const continuing =
    header.finalization &&
    (initialPath === header.finalization.source ||
      initialPath === header.finalization.target);
  if (
    !initialPath.endsWith(PARTIAL_SUFFIX) &&
    !continuing
  ) {
    await checkVersion(initialPath, sourceRevision);
    const stat = await volume.commit(
      initialPath,
      [],
      info.fileSize,
    );
    verification.remember(
      volume,
      initialPath,
      stat,
      fingerprint,
    );
    return stat;
  }
  const source = continuing
    ? header.finalization!.source
    : initialPath;
  const preferred = continuing
    ? header.finalization!.target
    : initialPath.slice(0, -PARTIAL_SUFFIX.length);
  const parts = preferred.split("/");
  const storedName = parts.pop()!;
  const parent = parts.length ? `${parts.join("/")}/` : "";
  const name =
    volume.kind === "directory"
      ? decodeDirectoryFilename(storedName)
      : storedName;
  let encoded = name !== storedName;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";

  const matches = async (
    path: string,
    stat: VfsStat,
  ): Promise<boolean> => {
    if (stat.kind !== "file") return false;
    if (stat.size !== info.fileSize) {
      try {
        const candidate = await readPartialHeader(
          volume,
          path,
          stat.size,
        );
        if (
          candidate.info.id !== record.id ||
          candidate.finalization?.source !== source ||
          candidate.finalization.target !== path
        )
          return false;
      } catch {
        return false;
      }
    }
    const file = await volume.file(path, {
      name: info.fileName,
      type: info.mimetype ?? "",
      lastModified: info.lastModified ?? 0,
    });
    return (
      contentKey(
        await verification.verify(
          volume,
          path,
          stat,
          file.slice(0, info.fileSize),
          { signal: options.signal },
        ),
      ) === contentKey(fingerprint)
    );
  };
  const finish = async (
    target: string,
    stat: VfsStat,
  ): Promise<VfsStat> => {
    await checkVersion(target, stat.revision);
    const old = await volume.stat(source);
    if (old) {
      if (
        source === initialPath &&
        old.revision !== sourceRevision
      )
        throw new StorageUnavailableError(
          "Temporary file changed while completing",
        );
      const previous = await readPartialHeader(
        volume,
        source,
        old.size,
      );
      if (
        previous.info.id !== record.id ||
        previous.finalization?.target !== target ||
        (await volume.stat(source))?.revision !==
          old.revision
      )
        throw new StorageUnavailableError(
          "Temporary file changed while completing",
        );
      await checkVersion(target, stat.revision);
      await volume.remove(source);
    }
    await checkVersion(target, stat.revision);
    record.path = target;
    record.finalization = { source, target };
    moved();
    // On failure the destination still contains its ID and committed checkpoints.
    const completed =
      stat.size === info.fileSize
        ? stat
        : await volume.commit(target, [], info.fileSize);
    verification.forget(volume.id, source);
    verification.remember(
      volume,
      target,
      completed,
      fingerprint,
    );
    return completed;
  };

  for (let counter = 0; counter < 10_000; counter++) {
    options.signal?.throwIfAborted();
    const candidate = counter
      ? `${stem} (${counter})${extension}`
      : name;
    const target =
      parent +
      (encoded
        ? encodeDirectoryFilename(candidate)
        : candidate);
    try {
      const existing = await volume.stat(target);
      if (existing) {
        if (
          header.finalization?.target === target &&
          (await matches(target, existing))
        )
          return finish(target, existing);
        // The data file is already at its recorded destination. Do not move damaged bytes elsewhere.
        if (target === initialPath)
          throw new StorageUnavailableError(
            "Completed destination failed verification",
          );
        continue;
      }
      if (
        target === source ||
        ((await volume.stat(
          `${target}${PARTIAL_SUFFIX}`,
        )) &&
          `${target}${PARTIAL_SUFFIX}` !== source)
      )
        continue;
      const finalization = { source, target };
      let before = await volume.stat(source);
      if (!before)
        throw new StorageUnavailableError(
          "Temporary file is unavailable",
        );
      if (before.revision !== sourceRevision)
        throw new StorageUnavailableError(
          "File changed while publishing completion",
        );
      if (
        header.finalization?.source !== source ||
        header.finalization.target !== target
      ) {
        const generation = header.generation + 1;
        before = await volume.commit(source, [
          {
            offset:
              header.metadataOffset +
              (generation % 2) * PARTIAL_SLOT_BYTES,
            data: await metadataSlot(
              info,
              generation,
              finalization,
            ),
          },
        ]);
        header = { ...header, generation, finalization };
        sourceRevision = before.revision;
        // Only the recovery trailer changed; the verified payload is unchanged.
        verification.remember(
          volume,
          source,
          before,
          fingerprint,
        );
      }
      record.finalization = finalization;
      let published: VfsStat | null;
      if (volume.move) {
        published = await volume.move(
          source,
          target,
          before.revision,
        );
        if (!published) continue;
        // Renaming preserves the verified payload, even if trailer cleanup must retry.
        verification.remember(
          volume,
          target,
          published,
          fingerprint,
        );
      } else {
        // External browser directories cannot rely on FileSystemHandle.move().
        // Keep the source trailer until the payload is committed and verified.
        // A recorded destination can be verified/reused after a crash, without another copy.
        if (await volume.stat(target)) continue;
        const file = (
          await volume.file(source, {
            name: info.fileName,
            type: info.mimetype ?? "",
            lastModified: info.lastModified ?? 0,
          })
        ).slice(0, info.fileSize);
        try {
          if (volume.writeFile)
            published = await volume.writeFile(
              target,
              file,
            );
          else {
            published = await volume.commit(
              target,
              [],
              file.size,
            );
            for (
              let offset = 0;
              offset < file.size;
              offset += 4 * 1024 * 1024
            )
              published = await volume.commit(target, [
                {
                  offset,
                  data: new Uint8Array(
                    await file
                      .slice(
                        offset,
                        offset + 4 * 1024 * 1024,
                      )
                      .arrayBuffer(),
                  ),
                },
              ]);
          }
          if (
            (await volume.stat(source))?.revision !==
              before.revision ||
            !(await matches(target, published))
          )
            throw new StorageUnavailableError(
              "File changed while publishing completion",
            );
        } catch (error) {
          await volume.remove(target).catch(() => {});
          throw error;
        }
      }
      return finish(target, published);
    } catch (error) {
      if (
        volume.kind === "directory" &&
        !encoded &&
        isDirectoryNameBlocked(error)
      ) {
        encoded = true;
        counter--;
        continue;
      }
      throw error;
    }
  }
  throw new Error("No unused filename is available");
}
