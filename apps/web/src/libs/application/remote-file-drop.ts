import { createSignal } from "solid-js";
import type {
  ClipboardScope,
  PlatformRuntime,
} from "@weblink/platform";
import { createUuid } from "../domain/ids";
import type { PeerSession } from "../domain/session";
import type {
  RemotePointer,
  PointerPosition,
} from "../domain/remote-control/pointer";
import {
  sameControlTarget,
  type ControlTarget,
} from "../domain/protocol/remote-control";
import type { FileDropRequest } from "../domain/protocol/file-drop";
import type { RequestContext } from "../domain/protocol/request-manager";
import type { RemoteControlHost } from "./remote-control-host";
import type { WebRtcProtocol } from "./rtc/rtc-protocol";
import type { RtcService } from "./rtc/rtc-service";
import type { TransferRegistry } from "./transfer/transfer-registry";
import type { FileCacheFactory } from "./cache-service";
import type { SharedFileTask } from "./task-service";
import {
  packClipboard,
  unpackClipboard,
  toNativeClipboard,
} from "./clipboard-content";
import {
  transferRemoteContent,
  type RemoteContentTransferJob,
} from "./remote-content-transfer";

import {
  remoteBundleLimit,
  resolveRemoteFileLimit,
} from "../domain/protocol/remote-file-limits";

interface Options {
  platform: PlatformRuntime;
  host: Pick<RemoteControlHost, "clipboardScope">;
  protocol: Pick<WebRtcProtocol, "call" | "handle">;
  rtc: Pick<RtcService, "onSessionClosed">;
  registry: TransferRegistry;
  caches: Pick<FileCacheFactory, "temporaryTransferCache">;
  enabled(): boolean;
  maxFileBytes?(): number;
  getSession(id: string): PeerSession | undefined;
}
interface Job extends RemoteContentTransferJob {
  grantId: string;
  target: ControlTarget;
  control?: RemotePointer;
  scope?: ClipboardScope;
  offered: boolean;
  maxFileBytes: number;
}
type Payload = FileDropRequest extends infer T
  ? T extends FileDropRequest
    ? Omit<T, "grantId" | "operationId">
    : never
  : never;

/** Transfers only copyable file bundles; native OLE acceptance is the final acknowledgement. */
export class RemoteFileDrop {
  private readonly jobs = new Map<PeerSession, Job>();
  private readonly consumed = new WeakMap<
    PeerSession,
    Set<string>
  >();
  private readonly state = createSignal<SharedFileTask[]>(
    [],
  );
  readonly tasks = this.state[0];
  private readonly stops: (() => void)[];
  private disposed = false;
  constructor(private readonly options: Options) {
    this.stops = [
      options.protocol.handle("remote-file-drop", (ctx) =>
        this.receive(ctx),
      ),
      options.rtc.onSessionClosed((session) => {
        const job = this.jobs.get(session);
        if (job) this.stop(job);
      }),
    ];
  }
  clearFinished = () =>
    this.state[1]((tasks) =>
      tasks.filter((t) =>
        ["waiting", "running", "finalizing"].includes(
          t.status,
        ),
      ),
    );
  private update(
    job: Job,
    change: Partial<SharedFileTask>,
  ) {
    if (!job.task) return;
    job.task = { ...job.task, ...change };
    this.state[1]((tasks) => [
      ...tasks.filter((t) => t.id !== job.id),
      job.task!,
    ]);
  }
  private check(job: Job) {
    job.lifetime.signal.throwIfAborted();
    if (
      this.disposed ||
      this.jobs.get(job.session) !== job ||
      this.options.getSession(
        job.session.targetClientId,
      ) !== job.session ||
      !job.session.isMessageChannelReady
    )
      throw new Error("File drop session ended");
    if (job.control) {
      const current = job.control.fileDropTarget();
      if (
        !this.options.enabled() ||
        !current ||
        current.grantId !== job.grantId ||
        !sameControlTarget(current.target, job.target)
      )
        throw new Error(
          "File drop disabled or control target changed",
        );
    } else {
      const scope = this.options.host.clipboardScope(
        job.session.targetClientId,
        job.grantId,
      );
      if (job.scope && job.scope.ownerId !== scope.ownerId)
        throw new Error("Control owner changed");
    }
  }
  syncPermissions() {
    for (const job of this.jobs.values()) {
      try {
        this.check(job);
      } catch {
        this.stop(job);
      }
    }
  }
  private cancelNative(job: Job) {
    if (job.scope)
      void this.options.platform.fileDrop
        ?.cancel(job.scope, job.id)
        .catch(() => {});
  }
  private stop(job: Job, error?: unknown, notify = true) {
    if (job.lifetime.signal.aborted) return;
    this.jobs.delete(job.session);
    job.lifetime.abort(
      error ??
        new DOMException(
          "File drop cancelled",
          "AbortError",
        ),
    );
    if (job.run) this.options.registry.destroy(job.run);
    this.cancelNative(job);
    if (
      job.task &&
      !["completed", "cancelled", "failed"].includes(
        job.task.status,
      )
    )
      this.update(job, {
        status: error ? "failed" : "cancelled",
        error:
          error instanceof Error
            ? error.message
            : undefined,
      });
    void job.cache?.cleanup().catch(() => {});
    if (notify && job.session.isMessageChannelReady)
      void this.options.protocol
        .call(
          job.session,
          "remote-file-drop",
          {
            action: "cancel",
            operationId: job.id,
            grantId: job.grantId,
            ...(error
              ? {
                  error: (error instanceof Error
                    ? error.message
                    : String(error)
                  ).slice(0, 1024),
                }
              : {}),
          },
          { retries: 0, timeoutMs: 5000 },
        )
        .catch(() => {});
  }
  private start(
    session: PeerSession,
    id: string,
    grantId: string,
    target: ControlTarget,
    control?: RemotePointer,
    maxFileBytes = this.options.maxFileBytes?.(),
  ): Job {
    const seen =
      this.consumed.get(session) ?? new Set<string>();
    if (seen.has(id) || seen.size >= 10000)
      throw new Error(
        "Stale file drop operation; reconnect to start again",
      );
    seen.add(id);
    this.consumed.set(session, seen);
    const old = this.jobs.get(session);
    if (old) this.stop(old);
    const job: Job = {
      id,
      session,
      grantId,
      target,
      control,
      lifetime: new AbortController(),
      offered: false,
      maxFileBytes: resolveRemoteFileLimit(maxFileBytes),
    };
    this.jobs.set(session, job);
    const timer = setTimeout(
      () =>
        this.stop(job, new Error("File drop timed out")),
      120000,
    );
    job.lifetime.signal.addEventListener(
      "abort",
      () => clearTimeout(timer),
      { once: true },
    );
    control?.addEventListener(
      "change",
      () => this.syncPermissions(),
      { signal: job.lifetime.signal },
    );
    return job;
  }
  private call(job: Job, payload: Payload) {
    this.check(job);
    return this.options.protocol.call(
      job.session,
      "remote-file-drop",
      {
        ...payload,
        grantId: job.grantId,
        operationId: job.id,
      },
      {
        signal: job.lifetime.signal,
        timeoutMs: 120000,
        retries: 0,
      },
    );
  }
  private transfer(job: Job, size: number, file?: File) {
    if (size > remoteBundleLimit(job.maxFileBytes, false))
      throw new Error(
        "File drop bundle exceeds its size limit",
      );
    return transferRemoteContent(
      {
        registry: this.options.registry,
        caches: this.options.caches,
        origin: "drop",
        fileName: "File drop",
        check: () => this.check(job),
        update: (change) => this.update(job, change),
        stop: (error) => this.stop(job, error),
      },
      job,
      size,
      "binary",
      file,
    );
  }
  async drop(
    peerId: string,
    control: RemotePointer,
    point: PointerPosition,
    readFiles: (
      signal: AbortSignal,
      maxFileBytes: number,
    ) => Promise<File[]>,
    signal?: AbortSignal,
    prepared?: (hasTask: boolean) => void,
  ): Promise<void> {
    const session = this.options.getSession(peerId);
    const target = control.fileDropTarget();
    if (!session || !target || !this.options.enabled())
      throw new Error("Remote file drop unavailable");
    signal?.throwIfAborted();
    const job = this.start(
      session,
      createUuid(),
      target.grantId,
      target.target,
      control,
    );
    const abort = () => this.stop(job);
    signal?.addEventListener("abort", abort, {
      once: true,
    });
    try {
      this.check(job);
      // Start reading inside the trusted drop event, before DataTransfer becomes protected.
      const files = readFiles(
        job.lifetime.signal,
        job.maxFileBytes,
      );
      void files.catch(() => {});
      await this.call(job, {
        action: "prepare",
        destination: job.target,
        maxFileBytes: job.maxFileBytes,
        point,
      });
      const content = (await files).map((file) => ({
        type: "file" as const,
        name: file.name,
        blob: file,
      }));
      this.check(job);
      const bundle = await packClipboard(
        content,
        job.maxFileBytes,
      );
      await this.transfer(job, bundle.size, bundle);
      prepared?.(!!job.task);
      await this.call(job, {
        action: "offer",
        size: bundle.size,
      });
      this.check(job);
      this.update(job, { status: "completed" });
      this.stop(job, undefined, false);
    } catch (error) {
      this.stop(job, error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private async receive({
    session,
    message,
    signal,
  }: RequestContext<"remote-file-drop", PeerSession>) {
    let job = this.jobs.get(session);
    if (message.action === "cancel") {
      if (
        job?.id === message.operationId &&
        job.grantId === message.grantId
      )
        this.stop(
          job,
          message.error
            ? new Error(message.error)
            : undefined,
          false,
        );
      return;
    }
    const native = this.options.platform.fileDrop;
    if (!native)
      throw new Error("Host file drop unavailable");
    if (message.action === "prepare") {
      const scope = this.options.host.clipboardScope(
        session.targetClientId,
        message.grantId,
      );
      job = this.start(
        session,
        message.operationId,
        message.grantId,
        message.destination,
        undefined,
        resolveRemoteFileLimit(message.maxFileBytes),
      );
      job.scope = scope;
    }
    if (
      !job ||
      job.control ||
      job.id !== message.operationId ||
      job.grantId !== message.grantId
    )
      throw new Error("Unsolicited file drop");
    const current = job;
    const abort = () => this.stop(current);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      this.check(job);
      if (message.action === "prepare") {
        await native.prepare(
          job.scope!,
          job.id,
          job.target,
          message.point,
          job.maxFileBytes,
        );
        this.check(job);
        return;
      }
      if (job.offered)
        throw new Error("File drop already consumed");
      job.offered = true;
      const bundle = await this.transfer(job, message.size);
      this.check(job);
      const content = await unpackClipboard(
        bundle!,
        job.maxFileBytes,
      );
      if (content.some((entry) => entry.type !== "file"))
        throw new Error("Only files can be dropped");
      const entries = await toNativeClipboard(content);
      this.check(job);
      await native.apply(
        job.scope!,
        job.id,
        entries.map((entry) => ({
          name: entry.name!,
          data: entry.data,
        })),
      );
      this.check(job);
      this.update(job, { status: "completed" });
      this.stop(job, undefined, false);
    } catch (error) {
      this.stop(job, error);
      // prepare may finish after cancellation reached the native queue.
      this.cancelNative(job);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  dispose() {
    this.disposed = true;
    for (const stop of this.stops) stop();
    for (const job of this.jobs.values()) this.stop(job);
  }
}
