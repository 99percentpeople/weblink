export type CryptoOperation =
  | {
      type: "derive";
      password: string;
      salt: Uint8Array;
      iterations: number;
      hash: string;
    }
  | {
      type: "encrypt" | "decrypt";
      key: Uint8Array;
      iv: Uint8Array;
      data: Uint8Array;
    }
  | { type: "hmac"; key: string; message: string };
export type CryptoWorkerRequest = {
  id: number;
  operation: CryptoOperation;
};
export type CryptoWorkerResponse =
  | { id: number; result: Uint8Array }
  | { id: number; error: string };

const WORKER_IDLE_MS = 30_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_PENDING_OPERATIONS = 128;
/** One lazy worker shared by the application's encrypted peer transports. */
export class CryptoWorkerClient {
  private worker?: Worker;
  private sequence = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<
    number,
    {
      resolve(value: Uint8Array): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(
        new URL("./encrypt-worker.ts", import.meta.url),
        { type: "module" },
      ),
  ) {}
  private dispose(error: Error) {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  private scheduleIdle() {
    if (!this.pending.size)
      this.idleTimer = setTimeout(
        () => this.dispose(new Error("Crypto worker idle")),
        WORKER_IDLE_MS,
      );
  }
  run(operation: CryptoOperation): Promise<Uint8Array> {
    if (this.pending.size >= MAX_PENDING_OPERATIONS)
      return Promise.reject(
        new Error("Crypto worker queue is full"),
      );
    clearTimeout(this.idleTimer);
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = ({
          data,
        }: MessageEvent<CryptoWorkerResponse>) => {
          if (this.worker !== worker) return;
          const request = this.pending.get(data.id);
          if (!request) return;
          this.pending.delete(data.id);
          clearTimeout(request.timer);
          if ("error" in data)
            request.reject(new Error(data.error));
          else request.resolve(data.result);
          this.scheduleIdle();
        };
        worker.onerror = (event) => {
          if (this.worker === worker)
            this.dispose(
              new Error(
                event.message
                  ? `Crypto worker failed: ${event.message}`
                  : "Crypto worker failed",
              ),
            );
        };
        worker.onmessageerror = () => {
          if (this.worker === worker)
            this.dispose(
              new Error(
                "Crypto worker response could not be decoded",
              ),
            );
        };
      }
      return new Promise((resolve, reject) => {
        const id = ++this.sequence;
        const timer = setTimeout(
          () =>
            this.dispose(
              new Error("Crypto operation timed out"),
            ),
          OPERATION_TIMEOUT_MS,
        );
        this.pending.set(id, { resolve, reject, timer });
        try {
          this.worker!.postMessage({ id, operation });
        } catch (error) {
          this.dispose(
            error instanceof Error
              ? error
              : new Error(String(error)),
          );
        }
      });
    } catch (error) {
      this.scheduleIdle();
      return Promise.reject(error);
    }
  }
}
