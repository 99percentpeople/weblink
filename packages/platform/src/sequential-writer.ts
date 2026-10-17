import type {
  VfsStat,
  VfsWrite,
  VfsWriter,
} from "./filesystem";

/** Snapshot submissions, serialize writes, and never continue past a failed write. */
export function sequentialWriter(port: {
  write(
    data: Uint8Array<ArrayBuffer>,
    offset: number,
  ): Promise<void>;
  close(
    size: number,
    patches: readonly VfsWrite[],
  ): Promise<VfsStat>;
  abort(): Promise<void>;
}): VfsWriter {
  let size = 0;
  let tail = Promise.resolve();
  let ending = false;
  let aborted = false;
  let closed = false;
  let closing: Promise<VfsStat> | undefined;
  let aborting: Promise<void> | undefined;
  const unavailable = () =>
    new Error("File writer is closed");
  return {
    write(data) {
      if (ending) return Promise.reject(unavailable());
      const bytes = data.slice();
      const next = tail.then(async () => {
        if (aborted) throw unavailable();
        if (!bytes.length) return;
        await port.write(bytes, size);
        size += bytes.length;
      });
      tail = next;
      void next.catch(() => {});
      return next;
    },
    close(patches = []) {
      if (aborted) return Promise.reject(unavailable());
      if (closing) return closing;
      ending = true;
      const updates = patches.map(({ offset, data }) => ({
        offset,
        data: data.slice(),
      }));
      return (closing ??= tail.then(async () => {
        if (aborted) throw unavailable();
        if (
          updates.length > 16 ||
          updates.reduce(
            (sum, patch) => sum + patch.data.length,
            0,
          ) >
            64 * 1024 ||
          updates.some(
            ({ offset, data }) =>
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              offset + data.length > size,
          )
        )
          throw new Error("Invalid file metadata update");
        const stat = await port.close(size, updates);
        closed = true;
        return stat;
      }));
    },
    abort() {
      ending = aborted = true;
      return (aborting ??= (closing ?? tail)
        .catch(() => {})
        .then(() => (closed ? undefined : port.abort())));
    },
  };
}
