import type { ChunkCache } from "../domain/file";
import type { PeerSession } from "../domain/session";
import {
  CLIPBOARD_CHUNK_SIZE,
  type ClipboardContentKind,
} from "../domain/protocol/clipboard";
import { TransferMode } from "../domain/transfer/file-transferer";
import type { FileSender } from "../domain/transfer/file-sender";
import { FILE_TRANSFER_CHANNEL_PROTOCOL } from "../domain/transfer/protocol";
import type { FileCacheFactory } from "./cache-service";
import type {
  TransferRegistry,
  TransferRun,
} from "./transfer/transfer-registry";
import type { SharedFileTask } from "./task-service";
export interface RemoteContentTransferJob {
  id: string;
  session: PeerSession;
  lifetime: AbortController;
  cache?: ChunkCache;
  run?: TransferRun;
  task?: SharedFileTask;
}
interface RemoteContentTransferOptions {
  registry: TransferRegistry;
  caches: Pick<FileCacheFactory, "temporaryTransferCache">;
  check(): void;
  update(change: Partial<SharedFileTask>): void;
  stop(error?: unknown): void;
  origin: "clipboard" | "drop";
  fileName: string;
}
/** Reuse the normal file channel and registry, with private temporary caches. */
export async function transferRemoteContent(
  options: RemoteContentTransferOptions,
  job: RemoteContentTransferJob,
  size: number,
  kind: ClipboardContentKind,
  file?: File,
): Promise<File | undefined> {
  options.check();
  const id = `remote-${options.origin}_${job.id}`;
  const cache =
    await options.caches.temporaryTransferCache(id);
  job.cache = cache;
  try {
    options.check();
  } catch (e) {
    await cache.cleanup();
    throw e;
  }
  await cache.setInfo({
    fileName: `${options.fileName}.weblink`,
    fileSize: size,
    chunkSize: CLIPBOARD_CHUNK_SIZE,
    file,
  });
  options.check();
  // Text synchronization and single-chunk payloads do not enter the task list.
  if (kind === "binary" && size > CLIPBOARD_CHUNK_SIZE) {
    job.task = {
      id: job.id,
      shared: true,
      origin: options.origin,
      fileId: id,
      peerId: job.session.targetClientId,
      fileName: options.fileName,
      kind: file ? "file-send" : "file-receive",
      createdAt: Date.now(),
      total: size,
      bytes: 0,
      status: "waiting",
      canPause: false,
      canResume: false,
      pause: () => {},
      resume: async () => {},
      cancel: async () => options.stop(),
    };
    options.update({});
  }
  let resolve!: (file?: File) => void;
  let reject!: (error: unknown) => void;
  let finished = false;
  const completion = new Promise<File | undefined>(
    (a, b) => {
      resolve = a;
      reject = b;
    },
  );
  // Sending returns after setup; completion failures are still observed by the RPC lifetime.
  void completion.catch((e) => {
    if (!job.lifetime.signal.aborted) options.stop(e);
  });
  const run = options.registry.register({
    session: job.session,
    cache,
    taskId: job.id,
    mode: file ? TransferMode.Send : TransferMode.Receive,
    incomingChannel: !!file,
    lifecycle: {
      bind: (entry, signal) =>
        entry.transferer.addEventListener(
          "progress",
          ({ detail }) => {
            try {
              options.check();
              options.update({
                status: "running",
                bytes: detail.received,
              });
            } catch (e) {
              options.stop(e);
            }
          },
          { signal },
        ),
      complete: async () => {
        options.check();
        options.update({ status: "finalizing" });
        let received: File | undefined;
        if (!file) {
          await cache.flush();
          received = (await cache.mergeFile()) ?? undefined;
          options.check();
          if (!received || received.size !== size)
            throw new Error(
              "Remote content transfer size mismatch",
            );
        }
        finished = true;
        resolve(received);
      },
      failed: (_entry, error) => reject(error),
    },
  });
  job.run = run;
  run.signal.addEventListener(
    "abort",
    () => {
      if (!finished)
        reject(
          new Error("Remote content transfer interrupted"),
        );
    },
    { once: true },
  );
  job.lifetime.signal.addEventListener(
    "abort",
    () => reject(job.lifetime.signal.reason),
    { once: true },
  );
  if (file)
    run.transferer.addEventListener(
      "ready",
      () => {
        void (run.transferer as FileSender)
          .sendFile()
          .catch((error) =>
            options.registry.fail(run, error),
          );
      },
      { once: true, signal: run.signal },
    );
  await options.registry.initialize(run);
  options.check();
  if (file) return;
  const channel = await job.session.createChannel(
    `${id}-0`,
    FILE_TRANSFER_CHANNEL_PROTOCOL,
  );
  try {
    options.check();
  } catch (e) {
    channel.close();
    throw e;
  }
  options.registry.setChannel(run, channel);
  return completion;
}
