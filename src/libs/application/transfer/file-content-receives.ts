import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import type { TransferRun } from "./transfer-registry";

export interface ContentRecipient {
  id: string;
  fileId: string;
  complete(signal: AbortSignal): Promise<void>;
  paused(error?: unknown): void;
  /** Retire source preparation when its last recipient detaches, even before bind. */
  stop?(): void;
  release?(): Promise<void>;
}
type Subscriber = {
  recipient: ContentRecipient;
  controller: AbortController;
  started?: boolean;
};
interface ContentJob {
  source: ContentRecipient;
  recipients: Map<string, Subscriber>;
  run?: TransferRun;
  completing?: Promise<void>;
}

/** One authorized binary source per content. Waiting offers never return `have` early. */
export class FileContentReceives {
  private readonly jobs = new Map<string, ContentJob>();
  constructor(
    private readonly stop: (run: TransferRun) => void,
    private readonly stopPreparing: (
      fileId: string,
    ) => void = () => {},
  ) {}

  join(
    fingerprint: FileFingerprint,
    recipient: ContentRecipient,
  ): boolean {
    const key = contentKey(fingerprint);
    let job = this.jobs.get(key);
    if (!job) {
      job = { source: recipient, recipients: new Map() };
      this.jobs.set(key, job);
    }
    if (!job.recipients.has(recipient.id))
      job.recipients.set(recipient.id, {
        recipient,
        controller: new AbortController(),
      });
    return job.source.id === recipient.id;
  }

  reattach(
    fileId: string,
    messageId?: string,
  ): string | undefined {
    const job = [...this.jobs.values()].find(
      (job) =>
        job.source.fileId === fileId &&
        (!messageId || job.source.id === messageId) &&
        !job.recipients.has(job.source.id),
    );
    if (!job) return;
    job.recipients.set(job.source.id, {
      recipient: job.source,
      controller: new AbortController(),
    });
    return job.source.id;
  }

  ownsSource(fileId: string): boolean {
    return [...this.jobs.values()].some(
      (job) => job.source.fileId === fileId,
    );
  }
  bind(run: TransferRun): void {
    const found = [...this.jobs].find(
      ([, job]) =>
        job.source.id === (run.messageId ?? run.taskId),
    );
    if (!found) return;
    const [key, job] = found;
    job.run = run;
    run.transferer.addEventListener(
      "complete",
      () => {
        // Start completions before removing the reservation. Each callback binds its
        // own reference and checks its cancellation signal before emitting a receipt.
        job.completing = (async () => {
          for (;;) {
            const pending = [
              ...job.recipients.values(),
            ].filter(
              (item) =>
                item.recipient.id !== job.source.id &&
                !item.started,
            );
            if (!pending.length) break;
            await Promise.all(
              pending.map(async (item) => {
                item.started = true;
                try {
                  await item.recipient.complete(
                    item.controller.signal,
                  );
                } catch (error) {
                  if (!item.controller.signal.aborted)
                    item.recipient.paused(error);
                }
              }),
            );
          }
          if (this.jobs.get(key) === job)
            this.jobs.delete(key);
        })();
      },
      { once: true, signal: run.signal },
    );
    run.signal.addEventListener(
      "abort",
      () => {
        if (job.completing) {
          this.releaseDetached(job);
        } else this.fail(job.source.id, run.signal.reason);
      },
      { once: true },
    );
  }

  private releaseDetached(job: ContentJob): void {
    // Keep the source's bytes until waiting references have committed.
    void Promise.resolve(job.completing)
      .then(async () => {
        if (!job.recipients.has(job.source.id)) {
          job.source.paused();
          await job.source.release?.();
        }
      })
      .catch(console.error);
  }

  failFile(fileId: string, error?: unknown): void {
    const job = [...this.jobs.values()].find(
      (job) => job.source.fileId === fileId,
    );
    if (job) this.fail(job.source.id, error);
  }

  fail(id: string, error?: unknown): void {
    for (const [key, job] of this.jobs) {
      if (job.source.id !== id) continue;
      this.jobs.delete(key);
      for (const {
        recipient,
        controller,
      } of job.recipients.values()) {
        controller.abort();
        recipient.paused(error);
      }
      this.releaseDetached(job);
    }
  }

  /** Cancelling one offer leaves a source in use by other offers running. */
  cancel(fileId: string): boolean {
    for (const [key, job] of this.jobs) {
      const recipients = [
        ...job.recipients.values(),
      ].filter((item) => item.recipient.fileId === fileId);
      if (!recipients.length) continue;
      for (const { recipient, controller } of recipients) {
        job.recipients.delete(recipient.id);
        controller.abort();
        recipient.paused();
      }
      if (!job.recipients.size) {
        this.jobs.delete(key);
        job.source.stop?.();
        this.stopPreparing(job.source.fileId);
        if (job.run) this.stop(job.run);
        this.releaseDetached(job);
      }
      return true;
    }
    return false;
  }
  clear(): void {
    for (const job of [...this.jobs.values()]) {
      this.fail(job.source.id);
      job.source.stop?.();
      this.stopPreparing(job.source.fileId);
      if (job.run) this.stop(job.run);
    }
  }
}
