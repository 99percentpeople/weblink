import type { ChunkCache } from "@/libs/domain/file";
import type { FileMetaData } from "@/libs/domain/file";
import type { PeerSession } from "@/libs/domain/session";
import {
  TransferMode,
  type FileTransferer,
} from "@/libs/domain/transfer/file-transferer";
import type { ActiveFileTransfer } from "./file-transfer-state";

export interface TransferRegistration {
  session: PeerSession;
  messageId: string;
  cache: ChunkCache;
  mode: TransferMode;
  info?: FileMetaData;
  incomingChannel: boolean;
}
export interface TransferRegistryOptions {
  createTransfer(
    input: TransferRegistration,
  ): FileTransferer;
  publish(
    id: string,
    entry: ActiveFileTransfer | undefined,
  ): void;
  bind(
    entry: ActiveFileTransfer,
    signal: AbortSignal,
  ): void;
  complete(
    entry: ActiveFileTransfer,
    signal: AbortSignal,
  ): Promise<void>;
  failed(entry: ActiveFileTransfer, error: Error): void;
  automaticCacheDeletion(): boolean;
  reportError(error: unknown): void;
  channelTimeoutMs?: number;
}
export interface TransferRun extends ActiveFileTransfer {
  readonly signal: AbortSignal;
}
type Entry = {
  run: TransferRun;
  controller: AbortController;
  incomingChannel: boolean;
  initialized: boolean;
  finishing: boolean;
  pendingChannel?: RTCDataChannel;
  timer?: ReturnType<typeof setTimeout>;
  flushTimer?: ReturnType<typeof setInterval>;
  flushing?: Promise<void>;
  releaseCache: () => void;
};

/** Owns runs, never cache identity. Unknown/retired channels are not buffered globally. */
export class TransferRegistry {
  private readonly sessions = new Map<
    PeerSession,
    Map<string, Entry>
  >();
  private readonly cacheUsers = new Map<
    ChunkCache,
    number
  >();
  private readonly deleteWhenIdle = new Set<ChunkCache>();
  private readonly deleting = new WeakSet<ChunkCache>();
  // A paused/failed delivery still needs the shared cache even after its live run is gone.
  // Message identity survives session replacement and is reused by retry/resume.
  private readonly unfinishedDeliveries = new WeakMap<
    ChunkCache,
    Set<string>
  >();

  private deliveryKey(run: TransferRun): string {
    return JSON.stringify([
      run.session.clientId,
      run.session.targetClientId,
      run.messageId,
    ]);
  }

  constructor(
    private readonly options: TransferRegistryOptions,
  ) {}

  get(
    session: PeerSession,
    fileId: string,
  ): TransferRun | undefined {
    return this.sessions.get(session)?.get(fileId)?.run;
  }
  isCurrent(run: TransferRun): boolean {
    return (
      this.get(run.session, run.fileId) === run &&
      !run.signal.aborted
    );
  }
  private entry(run: TransferRun): Entry | undefined {
    const entry = this.sessions
      .get(run.session)
      ?.get(run.fileId);
    return entry?.run === run ? entry : undefined;
  }

  /** Preparation also holds a lease so another peer's completion cannot delete its cache. */
  retainCache(cache: ChunkCache): () => void {
    if (this.deleting.has(cache))
      throw new Error(`cache ${cache.id} is being deleted`);
    this.cacheUsers.set(
      cache,
      (this.cacheUsers.get(cache) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.cacheUsers.get(cache) ?? 1) - 1;
      if (count > 0) this.cacheUsers.set(cache, count);
      else {
        this.cacheUsers.delete(cache);
        if (
          this.deleteWhenIdle.delete(cache) &&
          !this.unfinishedDeliveries.get(cache)?.size
        ) {
          this.deleting.add(cache);
          void cache
            .cleanup()
            .catch(this.options.reportError);
        }
      }
    };
  }

  assertAvailable(
    session: PeerSession,
    fileId: string,
    mode: TransferMode,
  ): void {
    if (this.get(session, fileId))
      throw new Error(
        `file ${fileId} already has an active transfer to this peer`,
      );
    // Check before asynchronous cache creation as well as when registering the run.
    for (const entries of this.sessions.values()) {
      for (const { run } of entries.values()) {
        if (
          run.fileId === fileId &&
          (mode === TransferMode.Receive ||
            run.transferer.mode === TransferMode.Receive)
        )
          throw new Error(
            `file ${fileId} already has an active cache writer`,
          );
      }
    }
  }

  register(input: TransferRegistration): TransferRun {
    this.assertAvailable(
      input.session,
      input.cache.id,
      input.mode,
    );
    const releaseCache = this.retainCache(input.cache);
    let transferer: FileTransferer;
    try {
      transferer = this.options.createTransfer(input);
    } catch (error) {
      releaseCache();
      throw error;
    }
    const controller = new AbortController();
    const run: TransferRun = {
      id: crypto.randomUUID(),
      session: input.session,
      fileId: input.cache.id,
      messageId: input.messageId,
      transferer,
      signal: controller.signal,
    };
    const entry: Entry = {
      run,
      controller,
      incomingChannel: input.incomingChannel,
      initialized: false,
      finishing: false,
      releaseCache,
    };
    let entries = this.sessions.get(input.session);
    if (!entries)
      this.sessions.set(
        input.session,
        (entries = new Map()),
      );
    entries.set(run.fileId, entry);
    const deliveries =
      this.unfinishedDeliveries.get(input.cache) ??
      new Set<string>();
    deliveries.add(this.deliveryKey(run));
    this.unfinishedDeliveries.set(input.cache, deliveries);
    // Bind message observers before cleanup listeners; final events must reach the correct message.
    this.options.bind(run, controller.signal);
    transferer.addEventListener(
      "ready",
      () => {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      },
      { signal: controller.signal },
    );
    input.cache.addEventListener(
      "cleanup",
      () =>
        this.fail(
          run,
          new Error("transfer cache was deleted"),
        ),
      { signal: controller.signal },
    );
    transferer.addEventListener(
      "complete",
      () => {
        void this.finish(entry);
      },
      { signal: controller.signal },
    );
    transferer.addEventListener(
      "error",
      ({ detail }) => this.fail(run, detail),
      { signal: controller.signal },
    );
    transferer.addEventListener(
      "close",
      () => this.destroy(run),
      { signal: controller.signal },
    );
    entry.timer = setTimeout(
      () =>
        this.fail(
          run,
          new Error("file transfer channel timeout"),
        ),
      this.options.channelTimeoutMs ?? 30_000,
    );
    this.options.publish(run.id, run);
    return run;
  }

  /** Attach only after cache/worker initialization. A known run may have one early channel. */
  setChannel(
    run: TransferRun,
    channel: RTCDataChannel,
  ): void {
    const entry = this.entry(run);
    if (
      !entry ||
      run.signal.aborted ||
      entry.finishing ||
      channel.protocol !== "transfer" ||
      ["closing", "closed"].includes(channel.readyState)
    ) {
      channel.close();
      return;
    }
    const existing =
      entry.pendingChannel ?? run.transferer.channel;
    if (existing === channel) return;
    if (existing && existing.readyState !== "closed") {
      channel.close();
      return;
    }
    if (!entry.initialized) {
      entry.pendingChannel = channel;
      return;
    }
    try {
      run.transferer.setChannel(channel);
    } catch (error) {
      channel.close();
      this.fail(run, error);
    }
  }

  acceptChannel(
    session: PeerSession,
    fileId: string,
    channel: RTCDataChannel,
  ): void {
    const entry = this.sessions.get(session)?.get(fileId);
    if (!entry?.incomingChannel) {
      channel.close();
      return;
    }
    this.setChannel(entry.run, channel);
  }

  async initialize(
    run: TransferRun,
    afterInitialize?: () => void | Promise<void>,
  ): Promise<void> {
    const entry = this.entry(run);
    if (!entry)
      throw new Error("file transfer is no longer active");
    await run.transferer.initialize();
    this.assertCurrent(run);
    await afterInitialize?.();
    this.assertCurrent(run);
    entry.initialized = true;
    if (run.transferer.mode === TransferMode.Receive) {
      entry.flushTimer = setInterval(() => {
        if (entry.flushing || !this.isCurrent(run)) return;
        entry.flushing = run.transferer.cache
          .flush()
          .catch((error) => this.fail(run, error))
          .finally(() => {
            entry.flushing = undefined;
          });
      }, 1000);
    }
    const pending = entry.pendingChannel;
    entry.pendingChannel = undefined;
    if (pending) this.setChannel(run, pending);
  }

  assertCurrent(run: TransferRun): void {
    if (!this.isCurrent(run))
      throw new DOMException(
        "File transfer cancelled",
        "AbortError",
      );
  }

  private async finish(entry: Entry): Promise<void> {
    const { run } = entry;
    if (!this.isCurrent(run) || entry.finishing) return;
    entry.finishing = true;
    clearInterval(entry.flushTimer);
    clearTimeout(entry.timer);
    try {
      await entry.flushing;
      if (!this.isCurrent(run)) return;
      await this.options.complete(run, run.signal);
      if (!this.isCurrent(run)) return;
      const deliveries = this.unfinishedDeliveries.get(
        run.transferer.cache,
      );
      deliveries?.delete(this.deliveryKey(run));
      if (!deliveries?.size)
        this.unfinishedDeliveries.delete(
          run.transferer.cache,
        );
      if (
        run.transferer.mode === TransferMode.Send &&
        this.options.automaticCacheDeletion()
      )
        this.deleteWhenIdle.add(run.transferer.cache);
      this.destroy(run);
    } catch (error) {
      this.fail(run, error);
    }
  }

  fail(run: TransferRun, error: unknown): void {
    if (!this.isCurrent(run)) return;
    const failure =
      error instanceof Error
        ? error
        : new Error(String(error));
    this.options.failed(run, failure);
    this.destroy(run, failure);
  }

  destroy(run: TransferRun, reason?: Error): void {
    const entry = this.entry(run);
    if (!entry) return;
    if (!entry.finishing)
      this.deleteWhenIdle.delete(run.transferer.cache);
    // Remove ownership first: reentrant close/complete cannot destroy a newer run.
    const entries = this.sessions.get(run.session)!;
    entries.delete(run.fileId);
    if (entries.size === 0)
      this.sessions.delete(run.session);
    clearTimeout(entry.timer);
    clearInterval(entry.flushTimer);
    this.options.publish(run.id, undefined);
    const channel = run.transferer.channel;
    run.transferer.close();
    entry.controller.abort(reason);
    if (channel) channel.onmessage = null;
    channel?.close();
    entry.pendingChannel?.close();
    if (
      run.transferer.mode === TransferMode.Receive &&
      !entry.finishing
    ) {
      void run.transferer.cache
        .flush()
        .catch(this.options.reportError)
        .finally(entry.releaseCache);
    } else entry.releaseCache();
  }

  closeSession(session: PeerSession): void {
    for (const entry of [
      ...(this.sessions.get(session)?.values() ?? []),
    ])
      this.destroy(entry.run);
  }
  clear(): void {
    for (const session of [...this.sessions.keys()])
      this.closeSession(session);
  }
  destroyFile(fileId: string): void {
    for (const entries of [...this.sessions.values()])
      for (const entry of [...entries.values()])
        if (entry.run.fileId === fileId)
          this.destroy(entry.run);
  }
}
