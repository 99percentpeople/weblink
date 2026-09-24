// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FileFingerprintService } from "@/libs/application/file-fingerprint-service";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";

class TestWorker extends EventTarget {
  postMessage =
    vi.fn<(data: { id: string; file: Blob }) => void>();
  terminate = vi.fn();
  removeEventListener = vi.fn(super.removeEventListener);

  reply(data: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          id: this.postMessage.mock.calls.at(-1)![0].id,
          ...data,
        },
      }),
    );
  }
}

function setup() {
  const workers: TestWorker[] = [];
  const service = new FileFingerprintService(() => {
    const worker = new TestWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const file = new NodeFile(
    ["abc"],
    "sample.txt",
  ) as unknown as File;
  const fingerprint: FileFingerprint = {
    version: 1,
    algorithm: "blake3-256",
    size: file.size,
    digest:
      "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  };
  return { service, workers, file, fingerprint };
}

async function started(workers: TestWorker[], count = 1) {
  await vi.waitFor(() => {
    expect(workers).toHaveLength(count);
    expect(
      workers[count - 1].postMessage,
    ).toHaveBeenCalled();
  });
  return workers[count - 1];
}

beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(() => vi.unstubAllGlobals());

describe("file fingerprint worker lifecycle", () => {
  it("reports an actionable error when worker loading emits a plain Event", async () => {
    const f = setup();
    const pending = f.service.hash(f.file);
    const rejection = expect(pending).rejects.toThrow(
      /fingerprint worker.*reload/i,
    );
    const worker = await started(f.workers);
    worker.dispatchEvent(new Event("error"));
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(f.service.tasks()[0]).toMatchObject({
      status: "failed",
    });
    expect(f.service.tasks()[0].error).not.toBe("Error");
    expect(
      worker.removeEventListener.mock.calls.map(
        ([type]) => type,
      ),
    ).toEqual(["message", "error", "messageerror"]);
  });

  it("retains the original runtime error and stack when the browser supplies it", async () => {
    const f = setup();
    const reason = new TypeError(
      "worker initialization failed",
    );
    const pending = f.service.hash(f.file);
    const rejection = expect(pending).rejects.toBe(reason);
    const worker = await started(f.workers);
    worker.dispatchEvent(
      new ErrorEvent("error", {
        error: reason,
        message: reason.message,
      }),
    );
    await rejection;
  });

  it("includes the script location when only ErrorEvent details are available", async () => {
    const f = setup();
    const pending = f.service.hash(f.file);
    const rejection = expect(pending).rejects.toThrow(
      /Cannot load dependency.*fingerprint-worker\.js:12:3/,
    );
    const worker = await started(f.workers);
    worker.dispatchEvent(
      new ErrorEvent("error", {
        message: "Cannot load dependency",
        filename:
          "https://example.test/fingerprint-worker.js",
        lineno: 12,
        colno: 3,
      }),
    );
    await rejection;
  });

  it("rejects message deserialization failures rather than leaving the queue pending", async () => {
    const f = setup();
    const pending = f.service.hash(f.file);
    const rejection = expect(pending).rejects.toThrow(
      /deserialize.*fingerprint worker/i,
    );
    const worker = await started(f.workers);
    worker.dispatchEvent(new MessageEvent("messageerror"));
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("creates a new worker after a loading failure and permits retrying the same File", async () => {
    const f = setup();
    const failed = f.service.hash(f.file);
    const rejection =
      expect(failed).rejects.toBeInstanceOf(Error);
    const first = await started(f.workers);
    first.dispatchEvent(new Event("error"));
    await rejection;
    const pending = f.service.hash(f.file);
    const second = await started(f.workers, 2);
    second.reply({ fingerprint: f.fingerprint });
    await expect(pending).resolves.toEqual(f.fingerprint);
    expect(
      f.service.tasks().map((task) => task.status),
    ).toEqual(["failed", "completed"]);
    expect(second.terminate).not.toHaveBeenCalled();
  });

  it("shares a worker job while allowing one caller to cancel independently", async () => {
    const f = setup();
    const controller = new AbortController();
    const first = f.service.hash(f.file, {
      signal: controller.signal,
    });
    const rejection = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = f.service.hash(f.file);
    const worker = await started(f.workers);
    controller.abort();
    await rejection;
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ fingerprint: f.fingerprint });
    await expect(second).resolves.toEqual(f.fingerprint);
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });

  it("still rejects invalid results and stops a cancelled active worker", async () => {
    const f = setup();
    const pending = f.service.hash(f.file);
    const rejection = expect(pending).rejects.toThrow(
      "Invalid fingerprint worker result",
    );
    const worker = await started(f.workers);
    worker.reply({
      fingerprint: { ...f.fingerprint, size: 9 },
    });
    await rejection;
    const controller = new AbortController();
    const retry = f.service.hash(f.file, {
      signal: controller.signal,
    });
    const cancelled = expect(retry).rejects.toMatchObject({
      name: "AbortError",
    });
    const second = await started(f.workers, 2);
    controller.abort();
    await cancelled;
    expect(second.terminate).toHaveBeenCalledOnce();
  });
});
