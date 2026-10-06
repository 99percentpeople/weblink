import { createSignal } from "solid-js";
import type { PlatformRuntime } from "@weblink/platform";
import type { PeerSession } from "../domain/session";
import type { RemotePointer } from "../domain/remote-control/pointer";
import { RemoteKeyboard } from "../domain/remote-control/keyboard";
import { defaultRemoteKeyboardOptions } from "../domain/remote-control/keyboard-options";
import type { ClipboardFileDestination } from "../domain/remote-control/keyboard-options";
import { createUuid } from "../domain/ids";
import type {
  ClipboardContentKind,
  ClipboardRequest,
} from "../domain/protocol/clipboard";
import type { RequestContext } from "../domain/protocol/request-manager";
import type { FileCacheFactory } from "./cache-service";
import type { RemoteControlHost } from "./remote-control-host";
import type { WebRtcProtocol } from "./rtc/rtc-protocol";
import type { RtcService } from "./rtc/rtc-service";
import type { TransferRegistry } from "./transfer/transfer-registry";
import type { SharedFileTask } from "./task-service";
import {
  fromNativeClipboard,
  clipboardContentKind,
  packClipboard,
  toNativeClipboard,
  unpackClipboard,
  type ClipboardContent,
} from "./clipboard-content";
import {
  transferClipboard,
  type ClipboardTransferJob,
} from "./clipboard-transfer";

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
  fileDestination?(): ClipboardFileDestination;
  cacheFile?(
    file: File,
    signal: AbortSignal,
  ): Promise<void>;
  getSession(id: string): PeerSession | undefined;
}
interface Job extends ClipboardTransferJob {
  session: PeerSession;
  id: string;
  grantId: string;
  control?: RemotePointer;
  epoch?: string;
  requiresInputEpoch: boolean;
  lifetime: AbortController;
  baseline?: number;
  content?: ClipboardContent;
  offered: boolean;
  maxFileBytes: number;
  fileDestination?: ClipboardFileDestination;
}
export interface ClipboardCopyOptions {
  files?: boolean;
  receive?(
    content: ClipboardContent,
    signal: AbortSignal,
  ): Promise<void>;
}
/** One user operation per peer. Transfer completion is distinct from clipboard application. */
export class RemoteClipboard {
  private readonly consumed = new WeakMap<
    PeerSession,
    Set<string>
  >();
  private watching = new Map<
    PeerSession,
    {
      id: string;
      grantId: string;
      control: RemotePointer;
      changed: () => void;
      close: () => void;
    }
  >();
  private observers = new Map<
    PeerSession,
    { id: string; grantId: string; stop?: () => void }
  >();
  private jobs = new Map<PeerSession, Job>();
  private readonly state = createSignal<SharedFileTask[]>(
    [],
  );
  readonly tasks = this.state[0];
  private readonly stops: (() => void)[];
  private disposed = false;
  constructor(private readonly options: Options) {
    this.stops = [
      options.protocol.handle("remote-clipboard", (ctx) =>
        this.receive(ctx),
      ),
      options.rtc.onSessionClosed((session) => {
        const job = this.jobs.get(session);
        if (job) this.stop(job);
        this.watching.get(session)?.close();
        this.observers.get(session)?.stop?.();
        this.observers.delete(session);
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
      (!!job.control && !this.options.enabled()) ||
      this.jobs.get(job.session) !== job ||
      this.options.getSession(
        job.session.targetClientId,
      ) !== job.session ||
      !job.session.isMessageChannelReady
    )
      throw new Error(
        "Clipboard session ended or synchronization is disabled",
      );
    if (job.control) {
      if (
        job.fileDestination !== undefined &&
        job.fileDestination !== this.fileDestination()
      )
        throw new Error(
          "Clipboard file destination changed",
        );
      if (
        job.control.clipboardGrant() !== job.grantId ||
        (job.requiresInputEpoch &&
          job.control.clipboardEpoch() !== job.epoch)
      )
        throw new Error(
          "Remote control changed during clipboard operation",
        );
    } else
      this.options.host.clipboardScope(
        job.session.targetClientId,
        job.grantId,
      );
  }
  syncPermissions(): void {
    for (const [session, watch] of this.watching)
      if (
        !this.options.enabled() ||
        watch.control.clipboardGrant() !== watch.grantId ||
        this.options.getSession(session.targetClientId) !==
          session
      )
        watch.close();
    for (const [session, watch] of this.observers) {
      try {
        if (
          this.options.getSession(
            session.targetClientId,
          ) !== session
        )
          throw new Error("Clipboard disabled");
        this.options.host.clipboardScope(
          session.targetClientId,
          watch.grantId,
        );
      } catch {
        watch.stop?.();
        this.observers.delete(session);
      }
    }
    for (const job of this.jobs.values()) {
      try {
        this.check(job);
      } catch {
        this.stop(job);
      }
    }
  }
  private stop(job: Job, error?: unknown) {
    if (this.jobs.get(job.session) === job)
      this.jobs.delete(job.session);
    job.lifetime.abort(
      error ??
        new DOMException(
          "Clipboard operation cancelled",
          "AbortError",
        ),
    );
    if (job.run) this.options.registry.destroy(job.run);
    if (
      job.task &&
      !["completed", "failed", "cancelled"].includes(
        job.task.status,
      )
    )
      this.update(job, {
        status: error ? "failed" : "cancelled",
        error:
          error instanceof Error
            ? error.message
            : undefined,
        canPause: false,
      });
    void job.cache?.cleanup().catch(() => {});
  }
  private start(
    session: PeerSession,
    request: Pick<
      ClipboardRequest,
      "operationId" | "grantId" | "maxFileBytes"
    >,
    control?: RemotePointer,
  ): Job {
    const seen =
      this.consumed.get(session) ?? new Set<string>();
    if (seen.has(request.operationId))
      throw new Error(
        "Clipboard operation was already used",
      );
    // A bounded session ledger prevents a delayed request from reopening a retired transfer.
    if (seen.size >= 10000)
      throw new Error(
        "Reconnect to start more clipboard operations",
      );
    seen.add(request.operationId);
    this.consumed.set(session, seen);
    const old = this.jobs.get(session);
    if (old) this.stop(old);
    const job: Job = {
      session,
      id: request.operationId,
      grantId: request.grantId,
      control,
      epoch: control?.clipboardEpoch(),
      requiresInputEpoch: true,
      lifetime: new AbortController(),
      offered: false,
      maxFileBytes: resolveRemoteFileLimit(
        request.maxFileBytes,
      ),
    };
    this.jobs.set(session, job);
    try {
      this.check(job);
    } catch (error) {
      this.stop(job, error);
      throw error;
    }
    const timer = setTimeout(
      () =>
        this.stop(
          job,
          new Error("Clipboard operation timed out"),
        ),
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
  private controller(
    peerId: string,
    control: RemotePointer,
  ): Job {
    const session = this.options.getSession(peerId);
    const grantId = control.clipboardGrant();
    if (
      !session ||
      !grantId ||
      control.state() !== "active"
    )
      throw new Error("Remote control is not active");
    return this.start(
      session,
      {
        operationId: createUuid(),
        grantId,
        maxFileBytes: this.options.maxFileBytes?.(),
      },
      control,
    );
  }
  private call(
    job: Job,
    payload: Omit<
      ClipboardRequest,
      "grantId" | "operationId"
    >,
  ) {
    this.check(job);
    return this.options.protocol.call(
      job.session,
      "remote-clipboard",
      {
        ...payload,
        operationId: job.id,
        grantId: job.grantId,
        ...(payload.action === "prepare" ||
        payload.action === "read-current" ||
        (payload.action === "offer" &&
          payload.direction === "paste")
          ? { maxFileBytes: job.maxFileBytes }
          : {}),
      },
      {
        signal: job.lifetime.signal,
        timeoutMs: 120000,
        retries: 0,
      },
    );
  }
  private tap(job: Job, code: "KeyC" | "KeyV") {
    this.check(job);
    const keys = new RemoteKeyboard(
      {
        input: (event) => job.control!.input(event),
        cancel: () => job.control!.cancel(),
      },
      defaultRemoteKeyboardOptions,
    );
    if (!keys.tap(code, ["ControlLeft"]))
      throw new Error(
        "Remote clipboard shortcut could not be sent",
      );
  }
  watch(
    peerId: string,
    control: RemotePointer,
    changed: () => void,
  ): () => void {
    const session = this.options.getSession(peerId);
    const grantId = control.clipboardGrant();
    if (!session || !grantId || !this.options.enabled())
      return () => {};
    this.watching.get(session)?.close();
    const id = createUuid();
    const life = new AbortController();
    const close = () => {
      if (this.watching.get(session)?.id !== id) return;
      this.watching.delete(session);
      life.abort();
      void this.options.protocol
        .call(
          session,
          "remote-clipboard",
          { action: "unwatch", grantId, operationId: id },
          { retries: 0 },
        )
        .catch(() => {});
    };
    this.watching.set(session, {
      id,
      grantId,
      control,
      changed,
      close,
    });
    control.addEventListener(
      "change",
      () => this.syncPermissions(),
      { signal: life.signal },
    );
    void this.options.protocol
      .call(
        session,
        "remote-clipboard",
        { action: "watch", grantId, operationId: id },
        { signal: life.signal, retries: 0 },
      )
      .catch(close);
    return close;
  }
  async copy(
    peerId: string,
    control: RemotePointer,
    selection = true,
    options: ClipboardCopyOptions = {},
  ): Promise<ClipboardContent> {
    const job = this.controller(peerId, control);
    job.fileDestination = this.fileDestination();
    try {
      if (selection) {
        await this.call(job, { action: "prepare" });
        this.tap(job, "KeyC");
      }
      // Copy injects no more input. Focus resets can safely leave its transfer running.
      // The grant, connection, settings and explicit cancellation still apply.
      job.requiresInputEpoch = false;
      await this.call(job, {
        action: selection ? "read" : "read-current",
        files:
          job.fileDestination !== "off" &&
          options.files !== false,
      });
      this.check(job);
      let content = job.content ?? [];
      const files = content.filter(
        (entry) => entry.type === "file",
      );
      if (
        files.length &&
        (job.fileDestination === "off" ||
          options.files === false)
      )
        throw new Error("Clipboard files are disabled");
      if (files.length && job.fileDestination === "cache") {
        if (!this.options.cacheFile)
          throw new Error("File cache unavailable");
        for (const entry of files) {
          this.check(job);
          await this.options.cacheFile(
            new File([entry.blob], entry.name!),
            job.lifetime.signal,
          );
          this.check(job);
        }
        content = content.filter(
          (entry) => entry.type !== "file",
        );
      }
      await options.receive?.(content, job.lifetime.signal);
      this.check(job);
      this.update(job, {
        status: "completed",
        canPause: false,
      });
      return content;
    } catch (e) {
      this.stop(job, e);
      throw e;
    } finally {
      this.stop(job);
    }
  }
  private fileDestination(): ClipboardFileDestination {
    return this.options.fileDestination?.() ?? "clipboard";
  }
  async paste(
    peerId: string,
    control: RemotePointer,
    content: Promise<ClipboardContent> | ClipboardContent,
  ): Promise<void> {
    const job = this.controller(peerId, control);
    try {
      const value = await content;
      this.check(job);
      await this.send(job, value, "paste");
      // ACK means the complete payload is in the host clipboard, not just that bytes arrived.
      this.tap(job, "KeyV");
      this.update(job, {
        status: "completed",
        canPause: false,
      });
    } catch (e) {
      this.stop(job, e);
      throw e;
    } finally {
      this.stop(job);
    }
  }
  private async receive({
    session,
    message,
    signal,
  }: RequestContext<
    "remote-clipboard",
    PeerSession
  >): Promise<void> {
    signal.throwIfAborted();
    if (message.action === "unwatch") {
      const watch = this.observers.get(session);
      if (
        watch?.id === message.operationId &&
        watch.grantId === message.grantId
      ) {
        watch.stop?.();
        this.observers.delete(session);
      }
      return;
    }
    if (message.action === "watch") {
      if (!this.options.platform.clipboard)
        throw new Error("Host clipboard is unavailable");
      const scope = this.options.host.clipboardScope(
        session.targetClientId,
        message.grantId,
      );
      const watch = {
        id: message.operationId,
        grantId: message.grantId,
        stop: undefined as (() => void) | undefined,
      };
      this.observers.get(session)?.stop?.();
      this.observers.set(session, watch);
      const stop =
        await this.options.platform.clipboard.watch(
          scope,
          () => {
            this.syncPermissions();
            if (
              this.observers.get(session) !== watch ||
              this.jobs.has(session)
            )
              return;
            void this.options.protocol
              .call(
                session,
                "remote-clipboard",
                {
                  action: "changed",
                  operationId: watch.id,
                  grantId: watch.grantId,
                },
                { retries: 0 },
              )
              .catch(() => {});
          },
        );
      if (
        signal.aborted ||
        this.observers.get(session) !== watch
      )
        stop();
      else watch.stop = stop;
      return;
    }
    if (message.action === "changed") {
      this.syncPermissions();
      const watch = this.watching.get(session);
      if (
        watch?.id !== message.operationId ||
        watch.grantId !== message.grantId
      )
        throw new Error("Stale clipboard notification");
      if (!this.jobs.has(session)) watch.changed();
      return;
    }
    let job = this.jobs.get(session);
    if (
      message.action === "prepare" ||
      message.action === "read-current" ||
      (message.action === "offer" &&
        message.direction === "paste")
    ) {
      // Validate before replacing an existing local operation.
      if (!this.options.platform.clipboard)
        throw new Error("Host clipboard is unavailable");
      const scope = this.options.host.clipboardScope(
        session.targetClientId,
        message.grantId,
      );
      const baseline =
        await this.options.platform.clipboard.sequence(
          scope,
        );
      signal.throwIfAborted();
      job = this.start(session, message);
      job.baseline =
        message.action === "read-current"
          ? undefined
          : baseline;
    }
    if (
      !job ||
      job.id !== message.operationId ||
      job.grantId !== message.grantId
    )
      throw new Error(
        "Unsolicited or stale clipboard operation",
      );
    this.check(job);
    const current = job;
    const abort = () => this.stop(current);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (message.action === "prepare") return;
      if (
        message.action === "read" ||
        message.action === "read-current"
      ) {
        if (job.control || job.offered)
          throw new Error(
            "Clipboard read already consumed",
          );
        job.offered = true;
        const scope = this.options.host.clipboardScope(
          session.targetClientId,
          job.grantId,
        );
        const snapshot =
          await this.options.platform.clipboard!.read(
            scope,
            job.baseline,
            message.files,
            job.maxFileBytes,
          );
        this.check(job);
        // The native adapter can return no alternatives when files were excluded.
        const entries =
          message.files === false
            ? snapshot.entries.filter(
                (entry) =>
                  entry.type !== "file" &&
                  entry.type !== "directory",
              )
            : snapshot.entries;
        if (!entries.length && message.files === false) {
          this.stop(job);
          return;
        }
        const content = await fromNativeClipboard(
          entries,
          job.lifetime.signal,
          job.maxFileBytes,
        );
        await this.send(job, content, "copy");
      } else {
        if (
          job.offered ||
          (message.direction === "copy") !== !!job.control
        )
          throw new Error("Duplicate clipboard offer");
        job.offered = true;
        const file = await this.transfer(
          job,
          message.size!,
          message.kind!,
        );
        this.check(job);
        const content = await unpackClipboard(
          file!,
          job.maxFileBytes,
        );
        this.check(job);
        if (clipboardContentKind(content) !== message.kind)
          throw new Error(
            "Clipboard content kind mismatch",
          );
        if (message.direction === "copy")
          job.content = content;
        else {
          const entries = await toNativeClipboard(content);
          this.check(job);
          await this.options.platform.clipboard!.write(
            entries,
            this.options.host.clipboardScope(
              session.targetClientId,
              job.grantId,
            ),
            job.maxFileBytes,
          );
          this.check(job);
        }
      }
      if (!job.control) {
        this.update(job, {
          status: "completed",
          canPause: false,
        });
        this.stop(job);
      }
    } catch (e) {
      this.stop(job, e);
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async send(
    job: Job,
    content: ClipboardContent,
    direction: "copy" | "paste",
  ) {
    const file = await packClipboard(
      content,
      job.maxFileBytes,
    );
    const kind = clipboardContentKind(content);
    this.check(job);
    await this.transfer(job, file.size, kind, file);
    await this.call(job, {
      action: "offer",
      direction,
      size: file.size,
      kind,
    });
    this.check(job);
  }
  private transfer(
    job: Job,
    size: number,
    kind: ClipboardContentKind,
    file?: File,
  ) {
    if (size > remoteBundleLimit(job.maxFileBytes))
      throw new Error(
        "Clipboard bundle exceeds its size limit",
      );
    return transferClipboard(
      {
        registry: this.options.registry,
        caches: this.options.caches,
        check: () => this.check(job),
        update: (change) => this.update(job, change),
        stop: (error) => this.stop(job, error),
      },
      job,
      size,
      kind,
      file,
    );
  }
  dispose() {
    this.disposed = true;
    for (const stop of this.stops) stop();
    for (const watch of this.watching.values())
      watch.close();
    for (const watch of this.observers.values())
      watch.stop?.();
    this.observers.clear();
    for (const job of this.jobs.values()) this.stop(job);
  }
}
