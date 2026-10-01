import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CryptoWorkerClient,
  type CryptoWorkerRequest,
  type CryptoWorkerResponse,
} from "@/libs/domain/utils/encrypt/crypto-worker-client";
class WorkerStub {
  onmessage?: (event: {
    data: CryptoWorkerResponse;
  }) => void;
  onerror?: (event: { message: string }) => void;
  onmessageerror?: () => void;
  sent: CryptoWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(request: CryptoWorkerRequest) {
    this.sent.push(request);
  }
  reply(id: number, result: Uint8Array) {
    this.onmessage?.({ data: { id, result } });
  }
}
const operation = {
  type: "hmac" as const,
  key: "key",
  message: "message",
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("shared crypto worker", () => {
  it("correlates concurrent results and reuses one worker until idle", async () => {
    const worker = new WorkerStub(),
      factory = vi.fn(() => worker as unknown as Worker);
    const client = new CryptoWorkerClient(factory);
    const first = client.run(operation),
      second = client.run(operation);
    worker.reply(worker.sent[1].id, new Uint8Array([2]));
    worker.reply(worker.sent[0].id, new Uint8Array([1]));
    expect(await first).toEqual(new Uint8Array([1]));
    expect(await second).toEqual(new Uint8Array([2]));
    expect(factory).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    const next = client.run(operation);
    worker.reply(worker.sent[2].id, new Uint8Array([3]));
    await next;
    expect(factory).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30000);
  });
  it("rejects all pending jobs on worker failure and creates a clean replacement", async () => {
    const workers = [new WorkerStub(), new WorkerStub()];
    let index = 0;
    const client = new CryptoWorkerClient(
      () => workers[index++] as unknown as Worker,
    );
    const first = expect(
      client.run(operation),
    ).rejects.toThrow(
      "Crypto worker failed: module missing",
    );
    const second = expect(
      client.run(operation),
    ).rejects.toThrow(
      "Crypto worker failed: module missing",
    );
    workers[0].onerror?.({ message: "module missing" });
    await Promise.all([first, second]);
    const next = client.run(operation);
    workers[1].reply(
      workers[1].sent[0].id,
      new Uint8Array([3]),
    );
    await next;
    vi.advanceTimersByTime(30000);
  });
  it("bounds stalled operations and terminates the worker", async () => {
    const worker = new WorkerStub(),
      client = new CryptoWorkerClient(
        () => worker as unknown as Worker,
      );
    const rejected = expect(
      client.run(operation),
    ).rejects.toThrow("timed out");
    vi.advanceTimersByTime(30000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("propagates an operation error without stranding another request", async () => {
    const worker = new WorkerStub(),
      client = new CryptoWorkerClient(
        () => worker as unknown as Worker,
      );
    const failed = expect(
      client.run(operation),
    ).rejects.toThrow("invalid tag");
    const success = client.run(operation);
    worker.onmessage?.({
      data: { id: worker.sent[0].id, error: "invalid tag" },
    });
    worker.reply(worker.sent[1].id, new Uint8Array([1]));
    await failed;
    await success;
    vi.advanceTimersByTime(30000);
  });
});
