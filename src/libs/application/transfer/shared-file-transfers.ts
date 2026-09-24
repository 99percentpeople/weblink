import { createSignal } from "solid-js";
import type {
  ChunkCache,
  ChunkMetaData,
} from "@/libs/domain/file";
import type { PeerSession } from "@/libs/domain/session";
import {
  contentKey,
  isFileFingerprint,
  type FileFingerprint,
} from "@/libs/domain/protocol/file-fingerprint";
import type {
  ProtocolFileMetadata,
  RequestSharedFileMessage,
} from "@/libs/domain/protocol/messages";
import type { RequestContext } from "@/libs/domain/protocol/request-manager";
import { FILE_TRANSFER_CHANNEL_PROTOCOL } from "@/libs/domain/transfer/protocol";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { FileSender } from "@/libs/domain/transfer/file-sender";
import type { FileCacheFactory } from "../cache-service";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";
import type { RtcService } from "../rtc/rtc-service";
import type { SharedFileTask } from "../task-service";
import { ReferenceChunkCache } from "../files/reference-chunk-cache";
import type {
  TransferRegistry,
  TransferRun,
  TransferRegistration,
} from "./transfer-registry";
import type { FileContentReceives } from "./file-content-receives";

export interface SharedFileTransferOptions {
  protocol: Pick<WebRtcProtocol, "call" | "handle">;
  rtc: Pick<RtcService, "onSessionClosed">;
  registry: TransferRegistry;
  caches: Pick<
    FileCacheFactory,
    "library" | "getCache" | "createCache"
  >;
  receives: FileContentReceives;
  getSession(peerId: string): PeerSession | undefined;
  canShare(session: PeerSession): boolean;
  supports(session: PeerSession): boolean;
  reportError(error: unknown): void;
}
type Job = {
  task: SharedFileTask;
  info: ProtocolFileMetadata;
  fileId: string;
  session?: PeerSession;
  controller?: AbortController;
  run?: TransferRun;
  cache?: ChunkCache;
  preparing?: Promise<void>;
  cleanup?: Promise<void>;
};

/** Directory pulls own tasks and local references, never messages or room offers. */
export class SharedFileTransfers {
  private readonly jobs = new Map<string, Job>();
  private readonly state = createSignal<SharedFileTask[]>(
    [],
  );
  readonly tasks = this.state[0];
  downloadTask(
    peerId: string,
    sharedFileId: string,
    fingerprint?: FileFingerprint,
  ): SharedFileTask | undefined {
    return this.tasks().findLast(
      (task) =>
        task.kind === "file-receive" &&
        ((task.peerId === peerId &&
          this.jobs.get(task.id)?.info.id ===
            sharedFileId) ||
          (fingerprint &&
            this.jobs.get(task.id)?.info.fingerprint &&
            contentKey(
              this.jobs.get(task.id)!.info.fingerprint!,
            ) === contentKey(fingerprint))),
    );
  }
  private readonly stops: (() => void)[];
  private disposed = false;
  constructor(
    private readonly options: SharedFileTransferOptions,
  ) {
    this.stops = [
      options.protocol.handle(
        "request-shared-file",
        (ctx) => this.serve(ctx),
      ),
      options.caches.library.onUnshare((ids) =>
        this.revoke(ids),
      ),
      options.caches.library.onRemove((ids) => {
        this.revoke(ids);
        for (const job of this.jobs.values())
          if (ids.includes(job.fileId)) this.pause(job);
      }),
      options.rtc.onSessionClosed((session) => {
        for (const job of this.jobs.values())
          if (job.session === session) this.pause(job);
      }),
    ];
  }
  private update(
    job: Job,
    change: Partial<SharedFileTask>,
  ): void {
    // Cancellation is terminal, including late progress and verification callbacks.
    if (job.task.status === "cancelled") return;
    job.task = { ...job.task, ...change };
    this.state[1](
      [...this.jobs.values()].map((job) => job.task),
    );
  }
  private newJob(
    peerId: string,
    info: ProtocolFileMetadata,
    fileId: string,
    sending = false,
  ): Job {
    const job: Job = {
      info: {
        ...info,
        fingerprint: info.fingerprint && {
          ...info.fingerprint,
        },
      },
      fileId,
      task: {
        id: crypto.randomUUID(),
        shared: true,
        peerId,
        fileName: info.fileName,
        total: info.fileSize,
        bytes: 0,
        createdAt: Date.now(),
        status: "waiting",
        kind: sending ? "file-send" : "file-receive",
        canPause: true,
        canResume: !sending,
        pause: () => this.pause(job),
        resume: () => this.start(job),
        cancel: () => this.cancel(job),
      },
    };
    this.jobs.set(job.task.id, job);
    this.update(job, {});
    return job;
  }
  private assertSession(session: PeerSession): void {
    if (
      this.disposed ||
      this.options.getSession(session.targetClientId) !==
        session ||
      !session.isMessageChannelReady
    )
      throw new Error("Member is not connected");
  }
  private check(job: Job, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.assertSession(job.session!);
  }
  private async authorize(
    session: PeerSession,
    message: RequestSharedFileMessage,
  ): Promise<ChunkCache> {
    this.assertSession(session);
    if (!this.options.canShare(session))
      throw new Error("Shared file access is disabled");
    const cache =
      await this.options.caches.library.getSharedFile(
        message.fid,
      );
    const info = await cache?.getInfo();
    this.assertSession(session);
    if (
      !this.options.canShare(session) ||
      !cache ||
      !info?.isComplete ||
      !info.isShared ||
      !info.fingerprint ||
      contentKey(info.fingerprint) !==
        contentKey(message.fingerprint) ||
      info.chunkSize !== message.chunkSize
    )
      throw new Error("This file is no longer shared");
    return cache;
  }
  private async serve({
    session,
    message,
    signal,
  }: RequestContext<
    "request-shared-file",
    PeerSession
  >): Promise<void> {
    signal.throwIfAborted();
    const source = await this.authorize(session, message);
    signal.throwIfAborted();
    if (message.have) return;
    if (this.options.caches.getCache(message.transferId))
      throw new Error(
        "Transfer ID conflicts with a local file",
      );
    const info = (await source.getInfo())!;
    const job = this.newJob(
      session.targetClientId,
      { ...info, id: message.fid },
      message.transferId,
      true,
    );
    job.session = session;
    job.controller = new AbortController();
    const cancelSetup = () => job.controller?.abort();
    signal.addEventListener("abort", cancelSetup, {
      once: true,
    });
    if (signal.aborted) cancelSetup();
    const setupSignal = job.controller.signal;
    try {
      const cache = new ReferenceChunkCache(
        {
          ...info,
          id: job.fileId,
          fingerprint: message.fingerprint,
          contentKey: info.contentKey!,
          isShared: undefined,
        },
        async () =>
          (
            await this.authorize(session, message)
          ).getFile(),
        async () => {},
        async () => {},
      );
      this.check(job, setupSignal);
      const run = this.register(job, cache, true);
      run.transferer.addEventListener(
        "ready",
        () => {
          void (run.transferer as FileSender)
            .sendFile(message.ranges)
            .catch((error) =>
              this.options.registry.fail(run, error),
            );
        },
        { once: true, signal: run.signal },
      );
      await this.options.registry.initialize(run);
      await this.authorize(session, message);
      this.check(job, setupSignal);
    } catch (error) {
      this.fail(job, error);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelSetup);
    }
  }
  private register(
    job: Job,
    cache: ChunkCache,
    sending: boolean,
  ): TransferRun {
    const lifecycle: NonNullable<
      TransferRegistration["lifecycle"]
    > = {
      bind: (entry, signal) => {
        entry.transferer.addEventListener(
          "ready",
          () => {
            if (job.task.status !== "paused")
              this.update(job, { status: "running" });
          },
          { signal },
        );
        entry.transferer.addEventListener(
          "progress",
          ({ detail }) => {
            if (job.task.status !== "paused")
              this.update(job, {
                bytes: detail.received,
                status: "running",
              });
          },
          { signal },
        );
        entry.transferer.addEventListener(
          "close",
          () => {
            if (
              !["completed", "failed", "paused"].includes(
                job.task.status,
              )
            )
              this.update(job, {
                status: "paused",
                canPause: false,
              });
          },
          { signal },
        );
        cache.addEventListener(
          "merging",
          () => {
            if (job.task.status !== "paused")
              this.update(job, {
                status: "finalizing",
                canPause: false,
              });
          },
          { signal },
        );
      },
      complete: async (entry, signal) => {
        if (!sending) {
          if (job.task.status !== "paused")
            this.update(job, {
              status: "finalizing",
              canPause: false,
            });
          await cache.flush();
          const file = cache.verifyFile
            ? await cache.verifyFile(signal)
            : await this.options.caches.library.verifyReceived(
                cache,
                signal,
              );
          signal.throwIfAborted();
          if (!file)
            throw new Error(
              "Shared file verification failed",
            );
        }
        if (job.task.status !== "paused")
          this.update(job, {
            status: "completed",
            bytes: job.task.total,
            canPause: false,
            canResume: false,
          });
      },
      failed: (_entry, error) => {
        this.update(job, {
          status: "failed",
          error: error.message,
          canPause: false,
        });
        if (!sending && job.task.status !== "cancelled")
          this.options.reportError(error);
      },
    };
    const run = this.options.registry.register({
      session: job.session!,
      cache,
      taskId: job.task.id,
      mode: sending
        ? TransferMode.Send
        : TransferMode.Receive,
      incomingChannel: sending,
      lifecycle,
    });
    job.run = run;
    const controller = job.controller!;
    run.signal.addEventListener(
      "abort",
      () => controller.abort(),
      { once: true },
    );
    if (!sending) this.options.receives.bind(run);
    return run;
  }
  async download(
    peerId: string,
    info: ProtocolFileMetadata,
  ): Promise<void> {
    if (
      !isFileFingerprint(info.fingerprint) ||
      info.fingerprint.size !== info.fileSize ||
      !info.chunkSize
    )
      throw new Error(
        "Member does not support shared file downloads",
      );
    // A directory click must not create tasks or aliases for bytes already in the library.
    await Promise.all(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.cleanup &&
            job.info.fingerprint &&
            contentKey(job.info.fingerprint) ===
              contentKey(info.fingerprint!),
        )
        .map((job) => job.cleanup),
    );
    if (
      await this.options.caches.library.hasContent(
        info.fingerprint,
      )
    )
      return;
    if (
      [...this.jobs.values()].some(
        (job) =>
          job.task.kind === "file-receive" &&
          ["waiting", "running", "finalizing"].includes(
            job.task.status,
          ) &&
          job.info.fingerprint &&
          contentKey(job.info.fingerprint) ===
            contentKey(info.fingerprint!),
      )
    )
      return;
    let job = [...this.jobs.values()].findLast(
      (job) =>
        job.task.kind === "file-receive" &&
        !["completed", "cancelled"].includes(
          job.task.status,
        ) &&
        job.task.peerId === peerId &&
        job.info.id === info.id,
    );
    if (
      job &&
      ["waiting", "running", "finalizing"].includes(
        job.task.status,
      )
    )
      return;
    job ??= this.newJob(
      peerId,
      info,
      `shared-transfer_${crypto.randomUUID()}`,
    );
    await this.start(job);
  }
  private start(job: Job): Promise<void> {
    if (job.preparing) {
      if (
        job.controller?.signal.aborted &&
        job.task.canResume
      )
        return job.preparing.then(() => this.start(job));
      return job.preparing;
    }
    const pending = Promise.resolve()
      .then(() => this.startAttempt(job))
      .finally(() => {
        if (job.preparing === pending)
          job.preparing = undefined;
      });
    job.preparing = pending;
    return pending;
  }
  private async startAttempt(job: Job): Promise<void> {
    if (!job.task.canResume) return;
    if (
      job.controller &&
      !job.controller.signal.aborted &&
      job.task.canPause &&
      job.session
    )
      return;
    const session = this.options.getSession(
      job.task.peerId,
    );
    try {
      if (!session)
        throw new Error("Member is not connected");
      this.assertSession(session);
      if (!this.options.supports(session))
        throw new Error(
          "Member does not support shared file downloads",
        );
    } catch (error) {
      this.update(job, {
        status: "failed",
        canPause: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
      throw error;
    }
    if (!session) return;
    job.session = session;
    job.controller = new AbortController();
    const signal = job.controller.signal;
    this.update(job, {
      status: "waiting",
      canPause: true,
      error: undefined,
    });
    const metadata: ChunkMetaData = {
      id: job.fileId,
      fileName: job.info.fileName,
      fileSize: job.info.fileSize,
      chunkSize: job.info.chunkSize,
      mimetype: job.info.mimetype,
      lastModified: job.info.lastModified,
      fingerprint: job.info.fingerprint,
      from: session.targetClientId,
      createdAt: job.task.createdAt,
      libraryPinned: true,
    };
    const payload = {
      fid: job.info.id,
      transferId: job.fileId,
      fingerprint: job.info.fingerprint!,
      chunkSize: job.info.chunkSize!,
    };
    try {
      // Check current remote permission even when no binary transfer is necessary.
      await this.options.protocol.call(
        session,
        "request-shared-file",
        { ...payload, have: true },
        { signal },
      );
      this.check(job, signal);
      const reuse = async (
        completionSignal: AbortSignal,
      ) => {
        const cache =
          await this.options.caches.library.reuse(
            payload.fingerprint,
            metadata,
            completionSignal,
          );
        completionSignal.throwIfAborted();
        if (!cache) return false;
        this.update(job, {
          status: "completed",
          bytes: job.task.total,
          canPause: false,
          canResume: false,
        });
        return true;
      };
      if (await reuse(signal)) return;
      if (
        this.options.receives.reattach(
          job.fileId,
          job.task.id,
        )
      )
        return;
      const source = this.options.receives.join(
        payload.fingerprint,
        {
          id: job.task.id,
          fileId: job.fileId,
          complete: async (completionSignal) => {
            if (!(await reuse(completionSignal)))
              throw new Error(
                "Shared content is unavailable",
              );
          },
          paused: (error) => {
            this.update(job, {
              status: error ? "failed" : "paused",
              canPause: false,
              error:
                error instanceof Error
                  ? error.message
                  : undefined,
            });
          },
          stop: () => job.controller?.abort(),
          release: async () => {
            if (job.task.status === "cancelled")
              await this.cleanup(job);
          },
        },
      );
      if (!source) return;
      let cache = this.options.caches.getCache(job.fileId);
      if (!cache) {
        cache = await this.options.caches.createCache(
          job.fileId,
        );
        job.cache = cache;
        this.check(job, signal);
        await cache.setInfo(metadata);
      }
      job.cache = cache;
      this.check(job, signal);
      const ranges = await cache.getReqRanges();
      this.check(job, signal);
      const run = this.register(job, cache, false);
      await this.options.registry.initialize(run);
      this.check(job, signal);
      await this.options.protocol.call(
        session,
        "request-shared-file",
        {
          ...payload,
          have: false,
          ranges: ranges ?? undefined,
        },
        { signal },
      );
      this.check(job, signal);
      const channel = await session.createChannel(
        `${job.fileId}-0`,
        FILE_TRANSFER_CHANNEL_PROTOCOL,
      );
      if (
        signal.aborted ||
        !this.options.registry.isCurrent(run)
      ) {
        channel.close();
        throw new DOMException(
          "Transfer cancelled",
          "AbortError",
        );
      }
      this.options.registry.setChannel(run, channel);
    } catch (error) {
      // A retired attempt must not fail a resumed or cancelled task.
      if (
        signal.aborted ||
        job.controller.signal !== signal
      )
        return;
      this.fail(job, error);
      if (job.task.status !== "cancelled") throw error;
    }
  }
  private fail(job: Job, error: unknown): void {
    this.options.receives.fail(job.task.id, error);
    if (job.run && this.options.registry.isCurrent(job.run))
      this.options.registry.fail(job.run, error);
    else if (job.task.status !== "paused")
      this.update(job, {
        status: "failed",
        canPause: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    job.controller?.abort();
  }
  private pause(job: Job): void {
    if (
      [
        "completed",
        "failed",
        "paused",
        "cancelled",
      ].includes(job.task.status)
    )
      return;
    this.update(job, { status: "paused", canPause: false });
    // A shared content source may still be needed by another authorized recipient.
    if (job.task.kind === "file-receive") {
      this.options.receives.cancel(job.fileId);
      if (this.options.receives.ownsSource(job.fileId))
        return;
    }
    job.controller?.abort();
    if (job.run) this.options.registry.destroy(job.run);
  }
  private async cancel(job: Job): Promise<void> {
    if (job.task.status === "completed") return;
    if (job.task.status === "cancelled") {
      if (
        job.task.kind === "file-receive" &&
        !this.options.receives.ownsSource(job.fileId)
      )
        await this.cleanup(job);
      return;
    }
    this.update(job, {
      status: "cancelled",
      canPause: false,
      canResume: false,
      error: undefined,
    });
    // Detach this download without interrupting other recipients of the same content.
    if (job.task.kind === "file-receive") {
      this.options.receives.cancel(job.fileId);
      if (this.options.receives.ownsSource(job.fileId))
        return;
    }
    job.controller?.abort();
    if (job.run) this.options.registry.destroy(job.run);
    if (job.task.kind === "file-receive")
      await this.cleanup(job);
  }
  private cleanup(job: Job): Promise<void> {
    if (job.cleanup) return job.cleanup;
    const pending = (async () => {
      // Cache creation may still be returning after cancellation. Wait for it so
      // neither metadata nor a late reference can recreate the cancelled file.
      await job.preparing?.catch(() => {});
      await job.cache?.flush().catch(() => {});
      await this.options.caches.library.discardReceive(
        job.fileId,
        job.info.fingerprint!,
        job.cache,
      );
    })();
    job.cleanup = pending;
    void pending.catch(() => {
      if (job.cleanup === pending) job.cleanup = undefined;
    });
    return pending;
  }
  private revoke(ids: readonly string[]): void {
    for (const job of this.jobs.values())
      if (
        job.task.kind === "file-send" &&
        ids.includes(job.info.id)
      )
        this.pause(job);
  }
  syncPermissions(): void {
    for (const job of this.jobs.values())
      if (
        job.task.kind === "file-send" &&
        job.session &&
        !this.options.canShare(job.session)
      )
        this.pause(job);
  }
  readonly clearFinished = (): void => {
    for (const [id, job] of this.jobs)
      if (
        ["completed", "failed", "cancelled"].includes(
          job.task.status,
        )
      )
        this.jobs.delete(id);
    this.state[1](
      [...this.jobs.values()].map((job) => job.task),
    );
  };
  dispose(): void {
    this.disposed = true;
    this.stops.forEach((stop) => stop());
    for (const job of this.jobs.values()) this.pause(job);
  }
}
