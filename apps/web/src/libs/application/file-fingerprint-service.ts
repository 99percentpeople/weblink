import { createSignal } from "solid-js";
import FingerprintWorker from "@/libs/infrastructure/storage/fingerprint-worker?worker";
import {
  isFileFingerprint,
  type FileFingerprint,
} from "@/libs/domain/protocol/file-fingerprint";

export interface FingerprintOptions {
  /** Local reference whose transfer owns this identification/verification phase. */
  fileId?: string;
  signal?: AbortSignal;
  onProgress?(bytes: number): void;
}
export interface FilePreparation {
  id: string;
  kind: "file-prepare";
  /** A deduplicated hash job can prepare references for several recipients. */
  fileIds?: readonly string[];
  peerId: string;
  fileName: string;
  createdAt: number;
  status:
    | "waiting"
    | "running"
    | "completed"
    | "cancelled"
    | "failed";
  bytes: number;
  total: number;
  cancel(): void;
  error?: string;
}
interface Job {
  id: string;
  promise: Promise<FileFingerprint>;
  controller: AbortController;
  listeners: Set<(bytes: number) => void>;
  users: number;
  done: boolean;
}

/** One worker and one read at a time; callers can cancel independently. */
export class FileFingerprintService {
  private readonly state = createSignal<FilePreparation[]>(
    [],
  );
  readonly tasks = this.state[0];
  clearFinished = () =>
    this.state[1]((items) =>
      items.filter(
        (item) =>
          item.status === "waiting" ||
          item.status === "running",
      ),
    );
  private worker?: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private jobs = new WeakMap<Blob, Job>();
  constructor(
    private readonly createWorker = () =>
      new FingerprintWorker(),
  ) {}

  hash(
    file: Blob,
    options: FingerprintOptions = {},
  ): Promise<FileFingerprint> {
    options.signal?.throwIfAborted();
    let job = this.jobs.get(file);
    if (!job) {
      const controller = new AbortController();
      const listeners = new Set<(bytes: number) => void>();
      const id = crypto.randomUUID();
      const next: Job = {
        id,
        controller,
        listeners,
        users: 0,
        done: false,
        promise: Promise.resolve(null!),
      };
      const update = (patch: Partial<FilePreparation>) =>
        this.state[1]((items) =>
          items.map((item) =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        );
      this.state[1]((items) => [
        ...items.filter(
          (item) =>
            item.status === "waiting" ||
            item.status === "running" ||
            items.indexOf(item) >= items.length - 50,
        ),
        {
          id,
          kind: "file-prepare",
          fileIds: options.fileId ? [options.fileId] : [],
          peerId: "",
          fileName: file instanceof File ? file.name : "",
          createdAt: Date.now(),
          status: "waiting",
          bytes: 0,
          total: file.size,
          cancel: () => controller.abort(),
        },
      ]);
      next.promise = this.tail
        .catch(() => {})
        .then(() => {
          controller.signal.throwIfAborted();
          update({ status: "running" });
          return this.run(
            file,
            controller.signal,
            (bytes) => {
              update({ bytes });
              for (const listener of listeners)
                listener(bytes);
            },
          );
        })
        .then(
          (value) => {
            next.done = true;
            update({
              status: "completed",
              bytes: file.size,
            });
            return value;
          },
          (error) => {
            update({
              status: controller.signal.aborted
                ? "cancelled"
                : "failed",
              error: controller.signal.aborted
                ? undefined
                : String(error),
            });
            this.jobs.delete(file);
            throw error;
          },
        );
      this.tail = next.promise.catch(() => {});
      this.jobs.set(file, next);
      job = next;
    }
    const current = job;
    const fileId = options.fileId;
    if (fileId)
      this.state[1]((items) =>
        items.map((item) =>
          item.id === current.id &&
          !item.fileIds?.includes(fileId)
            ? {
                ...item,
                fileIds: [...(item.fileIds ?? []), fileId],
              }
            : item,
        ),
      );
    current.users++;
    if (options.onProgress)
      current.listeners.add(options.onProgress);
    let stop = () => {};
    return new Promise<FileFingerprint>(
      (resolve, reject) => {
        const abort = () =>
          reject(
            options.signal?.reason ??
              new DOMException("Cancelled", "AbortError"),
          );
        options.signal?.addEventListener("abort", abort, {
          once: true,
        });
        stop = () =>
          options.signal?.removeEventListener(
            "abort",
            abort,
          );
        current.promise.then(resolve, reject);
        if (options.signal?.aborted) abort();
      },
    ).finally(() => {
      stop();
      if (options.onProgress)
        current.listeners.delete(options.onProgress);
      current.users--;
      if (!current.done && current.users === 0) {
        this.jobs.delete(file);
        current.controller.abort();
      }
    });
  }

  private run(
    file: Blob,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<FileFingerprint> {
    signal.throwIfAborted();
    const worker = (this.worker ??= this.createWorker());
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", error);
        worker.removeEventListener(
          "messageerror",
          messageError,
        );
        signal.removeEventListener("abort", abort);
      };
      const fail = (reason: unknown) => {
        cleanup();
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        reject(reason);
      };
      const abort = () => fail(signal.reason);
      const error = (event: Event) => {
        const details = event as ErrorEvent;
        if (
          details.error !== undefined &&
          details.error !== null
        )
          return fail(details.error);
        const message = details.message?.trim();
        if (message) {
          const location = details.filename
            ? [
                details.filename,
                details.lineno || undefined,
                details.colno || undefined,
              ]
                .filter((part) => part !== undefined)
                .join(":")
            : "";
          return fail(
            new Error(
              location
                ? `${message} (${location})`
                : message,
            ),
          );
        }
        return fail(
          new Error(
            "Fingerprint worker failed to load. Reload the page and try again.",
          ),
        );
      };
      const messageError = () =>
        fail(
          new Error(
            "Could not deserialize fingerprint worker response. Reload the page and try again.",
          ),
        );
      const message = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        if (event.data.error)
          return fail(new Error(event.data.error));
        if (event.data.fingerprint) {
          if (
            !isFileFingerprint(event.data.fingerprint) ||
            event.data.fingerprint.size !== file.size
          )
            return fail(
              new Error(
                "Invalid fingerprint worker result",
              ),
            );
          cleanup();
          resolve(event.data.fingerprint);
        } else if (Number.isSafeInteger(event.data.bytes))
          progress(event.data.bytes);
      };
      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      worker.addEventListener("messageerror", messageError);
      signal.addEventListener("abort", abort, {
        once: true,
      });
      try {
        worker.postMessage({ id, file });
      } catch (reason) {
        fail(reason);
      }
    });
  }
}
