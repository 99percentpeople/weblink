import type {
  BinarySource,
  VfsStat,
  VfsVolume,
} from "@weblink/platform";
import type { FileWriteOptions } from "@/libs/domain/file";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";
import { StorageUnavailableError } from "@/libs/domain/vfs";
import { withExclusiveTask } from "@/libs/utils/exclusive-task";
import { fingerprintBlob } from "../storage/fingerprint";

/** Verified bytes belong to a live file version, never to persisted peer metadata. */
export class DirectoryVerification {
  private readonly versions = new Map<
    string,
    { revision: string; fingerprint: FileFingerprint }
  >();

  private key(volume: VfsVolume, path: string): string {
    return JSON.stringify([volume.id, path]);
  }

  forget(
    volumeId: string,
    path: string,
    revision?: string,
  ): void {
    const key = JSON.stringify([volumeId, path]);
    if (
      revision === undefined ||
      this.versions.get(key)?.revision === revision
    )
      this.versions.delete(key);
  }

  /** Only callers that verified the bytes or moved/truncated that verified payload may publish a result. */
  remember(
    volume: VfsVolume,
    path: string,
    stat: VfsStat,
    fingerprint: FileFingerprint,
  ): void {
    this.versions.set(this.key(volume, path), {
      revision: stat.revision,
      fingerprint: { ...fingerprint },
    });
  }

  async verify(
    volume: VfsVolume,
    path: string,
    stat: VfsStat,
    file: BinarySource,
    options: FileWriteOptions = {},
    compute?: () => Promise<FileFingerprint>,
  ): Promise<FileFingerprint> {
    const key = this.key(volume, path);
    return withExclusiveTask(
      `directory-verify:${key}`,
      async () => {
        const check = async () => {
          options.signal?.throwIfAborted();
          const current = await volume.stat(path);
          options.signal?.throwIfAborted();
          if (
            current?.kind !== "file" ||
            current.revision !== stat.revision ||
            current.size !== stat.size
          )
            throw new StorageUnavailableError(
              "File changed while verifying completion",
            );
        };
        await check();
        const cached = this.versions.get(key);
        if (
          cached?.revision === stat.revision &&
          cached.fingerprint.size === file.size
        ) {
          options.onProgress?.({
            phase: "verifying",
            bytes: file.size,
          });
          return { ...cached.fingerprint };
        }
        this.versions.delete(key);
        options.onProgress?.({
          phase: "verifying",
          bytes: 0,
        });
        const fingerprint = compute
          ? await compute()
          : await fingerprintBlob(
              file,
              (bytes) =>
                options.onProgress?.({
                  phase: "verifying",
                  bytes,
                }),
              options.signal,
            );
        await check();
        this.remember(volume, path, stat, fingerprint);
        return fingerprint;
      },
    );
  }
}
