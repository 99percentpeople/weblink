import {
  SPEED_TEST_PROTOCOL,
  SPEED_TEST_DURATION_MS,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_BLOCK_BYTES,
  SPEED_TEST_HIGH_WATER,
  SPEED_TEST_LOW_WATER,
  SPEED_TEST_APPROVAL_MS,
  SPEED_TEST_HANDSHAKE_MS,
  SPEED_TEST_PHASE_TIMEOUT_MS,
  SPEED_TEST_TOTAL_TIMEOUT_MS,
  SpeedTestError,
  parseSpeedTestMessage,
  speedMeasurement,
  type SpeedTestDirection,
  type SpeedTestMessage,
  type SpeedTestProgress,
  type SpeedTestResult,
  type SpeedMeasurement,
} from "./speed-test-protocol";

type Role = "initiator" | "responder";
export interface SpeedTestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SpeedTestProgress) => void;
  /** Emits a completed measurement using directions relative to this client. */
  onMeasurement?: (
    direction: SpeedTestDirection,
    measurement: SpeedMeasurement,
  ) => void;
  /** The responder must explicitly approve; no callback means decline. */
  approve?: (signal: AbortSignal) => Promise<boolean>;
  maxMessageSize?: number;
  /** May only reduce the production duration/traffic limits. */
  durationMs?: number;
  maxBytes?: number;
}

export function createSpeedTestChannel(
  pc: RTCPeerConnection,
): RTCDataChannel {
  if (pc.connectionState !== "connected")
    throw new SpeedTestError("offline");
  // One temporary, reliable, ordered channel for BOTH directions. Ordering
  // makes the end marker follow every payload; it is not a file channel.
  return pc.createDataChannel(
    `speed-test-${crypto.randomUUID()}`,
    {
      protocol: SPEED_TEST_PROTOCOL,
      ordered: true,
    },
  );
}

function abortError(signal: AbortSignal): SpeedTestError {
  return signal.reason instanceof SpeedTestError
    ? signal.reason
    : new SpeedTestError("cancelled");
}

/** Also used while waiting on user approval, without trusting the callback. */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    promise
      .then(resolve, reject)
      .finally(() =>
        signal.removeEventListener("abort", onAbort),
      );
    if (signal.aborted) onAbort();
  });
}

function waitForChannel(
  channel: RTCDataChannel,
  signal: AbortSignal,
  threshold?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const event =
      threshold === undefined
        ? "open"
        : "bufferedamountlow";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener(event, check);
      channel.removeEventListener("close", closed);
      channel.removeEventListener("error", closed);
      signal.removeEventListener("abort", aborted);
    };
    const finish = (error?: SpeedTestError) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const closed = () =>
      finish(new SpeedTestError("closed"));
    const aborted = () => finish(abortError(signal));
    const check = () => {
      if (signal.aborted) return aborted();
      if (
        channel.readyState === "closing" ||
        channel.readyState === "closed"
      )
        return closed();
      if (
        channel.readyState === "open" &&
        (threshold === undefined ||
          channel.bufferedAmount <= threshold)
      )
        finish();
    };
    if (threshold !== undefined)
      channel.bufferedAmountLowThreshold = threshold;
    channel.addEventListener(event, check);
    channel.addEventListener("close", closed);
    channel.addEventListener("error", closed);
    signal.addEventListener("abort", aborted, {
      once: true,
    });
    if (threshold === undefined) {
      timer = setTimeout(
        () => finish(new SpeedTestError("timeout")),
        SPEED_TEST_HANDSHAKE_MS,
      );
    }
    check();
  });
}

/**
 * Test only DataChannel goodput. There is no File/Blob cache, compression,
 * IndexedDB or retained receive payload. Results use receiver timestamps and
 * byte counts, NOT send() enqueue time or candidate-pair bandwidth estimates.
 */
export async function runSpeedTest(
  channel: RTCDataChannel,
  role: Role,
  options: SpeedTestOptions = {},
): Promise<SpeedTestResult> {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const fail = (error: SpeedTestError) => {
    if (!signal.aborted) lifetime.abort(error);
  };
  const onExternalAbort = () =>
    fail(
      options.signal
        ? abortError(options.signal)
        : new SpeedTestError("cancelled"),
    );
  options.signal?.addEventListener(
    "abort",
    onExternalAbort,
    { once: true },
  );
  if (options.signal?.aborted) onExternalAbort();

  let durationMs =
    options.durationMs ?? SPEED_TEST_DURATION_MS;
  let maxBytes = options.maxBytes ?? SPEED_TEST_MAX_BYTES;
  let pending:
    | {
        type: SpeedTestMessage["type"];
        direction?: SpeedTestDirection;
        resolve: (message: SpeedTestMessage) => void;
        reject: (error: SpeedTestError) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let receiving:
    | {
        direction: SpeedTestDirection;
        bytes: number;
        startedAt?: number;
        endedAt?: number;
      }
    | undefined;
  let controls = 0;
  let awaitingReceipt = false;
  let lastProgressAt = -Infinity;
  const progress = (
    phase: SpeedTestProgress["phase"],
    bytes = 0,
    force = false,
  ) => {
    const now = performance.now();
    if (!force && now - lastProgressAt < 200) return;
    lastProgressAt = now;
    options.onProgress?.({ phase, bytes });
  };
  const rejectPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const request = pending;
    pending = undefined;
    request.reject(abortError(signal));
  };
  signal.addEventListener("abort", rejectPending);
  const onClose = () => fail(new SpeedTestError("closed"));
  channel.addEventListener("close", onClose);
  channel.addEventListener("error", onClose);
  channel.binaryType = "arraybuffer";

  function expect<T extends SpeedTestMessage["type"]>(
    type: T,
    timeoutMs = SPEED_TEST_PHASE_TIMEOUT_MS,
    direction?: SpeedTestDirection,
  ): Promise<SpeedTestMessage & { type: T }> {
    if (signal.aborted) throw abortError(signal);
    if (pending) throw new SpeedTestError("protocol");
    const promise = new Promise<SpeedTestMessage>(
      (resolve, reject) => {
        pending = {
          type,
          direction,
          resolve,
          reject,
          timer: setTimeout(
            () =>
              fail(
                new SpeedTestError(
                  type === "offer"
                    ? "unsupported"
                    : "timeout",
                ),
              ),
            timeoutMs,
          ),
        };
      },
    );
    // A receipt is registered before pumping data. Cancellation may reject it
    // during backpressure; observe immediately, then propagate via await below.
    void promise.catch(() => {});
    return promise as Promise<
      SpeedTestMessage & { type: T }
    >;
  }

  const send = (message: SpeedTestMessage) => {
    if (signal.aborted) throw abortError(signal);
    if (channel.readyState !== "open")
      throw new SpeedTestError("closed");
    channel.send(JSON.stringify(message));
  };

  const onMessage = (event: MessageEvent<unknown>) => {
    if (signal.aborted) return;
    try {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        if (
          !receiving ||
          receiving.startedAt === undefined ||
          receiving.endedAt !== undefined ||
          data.byteLength === 0 ||
          data.byteLength > SPEED_TEST_BLOCK_BYTES ||
          receiving.bytes + data.byteLength > maxBytes
        )
          throw new SpeedTestError("protocol");
        receiving.bytes += data.byteLength;
        progress("download", receiving.bytes);
        return;
      }
      if (typeof data !== "string" || ++controls > 32)
        throw new SpeedTestError("protocol");
      const message = parseSpeedTestMessage(data);
      if (message.type === "reject")
        throw new SpeedTestError(message.reason);
      if (message.type === "receipt" && !awaitingReceipt)
        throw new SpeedTestError("protocol");
      if (message.type === "begin") {
        if (
          !receiving ||
          receiving.direction !== message.direction ||
          receiving.startedAt !== undefined
        ) {
          throw new SpeedTestError("protocol");
        }
        receiving.startedAt = performance.now();
        return;
      }
      if (
        !pending ||
        message.type !== pending.type ||
        (pending.direction !== undefined &&
          (!("direction" in message) ||
            message.direction !== pending.direction))
      )
        throw new SpeedTestError("protocol");
      if (message.type === "end" && receiving)
        receiving.endedAt = performance.now();
      const request = pending;
      pending = undefined;
      clearTimeout(request.timer);
      request.resolve(message);
    } catch (error) {
      fail(
        error instanceof SpeedTestError
          ? error
          : new SpeedTestError("protocol"),
      );
    }
  };
  channel.addEventListener("message", onMessage);
  const totalTimer = setTimeout(
    () => fail(new SpeedTestError("timeout")),
    SPEED_TEST_TOTAL_TIMEOUT_MS,
  );

  async function sendPhase(
    direction: SpeedTestDirection,
  ): Promise<SpeedMeasurement> {
    progress("upload", 0, true);
    const go = expect(
      "go",
      SPEED_TEST_PHASE_TIMEOUT_MS,
      direction,
    );
    send({ type: "start", direction });
    await go;
    const limit = options.maxMessageSize;
    const blockSize = Math.floor(
      Math.min(
        SPEED_TEST_BLOCK_BYTES,
        limit === undefined || limit === 0
          ? Infinity
          : limit,
      ),
    );
    if (!Number.isFinite(blockSize) || blockSize < 1024)
      throw new SpeedTestError("unsupported");
    // Reuse a small, incompressible payload. The browser copies on send().
    const payload = crypto.getRandomValues(
      new Uint8Array(blockSize),
    );
    let bytes = 0;
    const receipt = expect(
      "receipt",
      SPEED_TEST_PHASE_TIMEOUT_MS,
      direction,
    );
    send({ type: "begin", direction });
    const startedAt = performance.now();
    while (
      bytes < maxBytes &&
      (bytes === 0 ||
        performance.now() - startedAt < durationMs)
    ) {
      if (signal.aborted) throw abortError(signal);
      const length = Math.min(blockSize, maxBytes - bytes);
      if (
        channel.bufferedAmount + length >
        SPEED_TEST_HIGH_WATER
      ) {
        await waitForChannel(
          channel,
          signal,
          SPEED_TEST_LOW_WATER,
        );
        continue;
      }
      channel.send(
        length === blockSize
          ? payload
          : payload.subarray(0, length),
      );
      bytes += length;
      progress("upload", bytes);
    }
    // Reliable ordering guarantees end follows all payload messages, even if
    // bufferedAmount is nonzero. Wait for the receiver's matching receipt.
    awaitingReceipt = true;
    send({ type: "end", direction, bytes });
    const result = await receipt;
    awaitingReceipt = false;
    if (signal.aborted) throw abortError(signal);
    if (result.bytes !== bytes)
      throw new SpeedTestError("protocol");
    progress("upload", bytes, true);
    return speedMeasurement(
      result.bytes,
      result.durationMs,
    );
  }

  async function receivePhase(
    direction: SpeedTestDirection,
  ): Promise<SpeedMeasurement> {
    progress("download", 0, true);
    await expect(
      "start",
      SPEED_TEST_PHASE_TIMEOUT_MS,
      direction,
    );
    receiving = { direction, bytes: 0 };
    const end = expect(
      "end",
      SPEED_TEST_PHASE_TIMEOUT_MS,
      direction,
    );
    send({ type: "go", direction });
    const message = await end;
    const record = receiving;
    receiving = undefined;
    if (
      !record ||
      record.startedAt === undefined ||
      record.endedAt === undefined ||
      record.bytes !== message.bytes ||
      record.bytes === 0
    )
      throw new SpeedTestError("protocol");
    const elapsedMs = Math.max(
      1,
      record.endedAt - record.startedAt,
    );
    if (elapsedMs > SPEED_TEST_PHASE_TIMEOUT_MS)
      throw new SpeedTestError("timeout");
    send({
      type: "receipt",
      direction,
      bytes: record.bytes,
      durationMs: elapsedMs,
    });
    progress("download", record.bytes, true);
    return speedMeasurement(record.bytes, elapsedMs);
  }

  try {
    if (
      channel.protocol !== SPEED_TEST_PROTOCOL ||
      !channel.ordered ||
      channel.maxRetransmits != null ||
      channel.maxPacketLifeTime != null
    )
      throw new SpeedTestError("protocol");
    // Validate local reduced limits through the same bounded wire parser.
    parseSpeedTestMessage(
      JSON.stringify({
        type: "hello",
        durationMs,
        maxBytes,
      }),
    );
    progress("connecting", 0, true);
    await waitForChannel(channel, signal);
    if (role === "initiator") {
      const offered = expect(
        "offer",
        SPEED_TEST_HANDSHAKE_MS,
      );
      send({ type: "hello", durationMs, maxBytes });
      await offered;
      progress("approval", 0, true);
      await expect(
        "ready",
        SPEED_TEST_APPROVAL_MS + SPEED_TEST_HANDSHAKE_MS,
      );
      const upload = await sendPhase("upload");
      options.onMeasurement?.("upload", upload);
      const download = await receivePhase("download");
      options.onMeasurement?.("download", download);
      return { upload, download, completedAt: Date.now() };
    }
    const hello = await expect(
      "hello",
      SPEED_TEST_HANDSHAKE_MS,
    );
    durationMs = hello.durationMs;
    maxBytes = hello.maxBytes;
    send({ type: "offer" });
    progress("approval", 0, true);
    let approvalTimer:
      | ReturnType<typeof setTimeout>
      | undefined;
    let approved: boolean;
    try {
      approved = await abortable(
        Promise.race([
          options.approve?.(signal) ??
            Promise.resolve(false),
          new Promise<boolean>((resolve) => {
            approvalTimer = setTimeout(
              () => resolve(false),
              SPEED_TEST_APPROVAL_MS,
            );
          }),
        ]),
        signal,
      );
    } finally {
      clearTimeout(approvalTimer);
    }
    if (!approved) {
      send({ type: "reject", reason: "declined" });
      throw new SpeedTestError("declined");
    }
    // Register before replying: a fast initiator may start immediately.
    const downloadPromise = receivePhase("upload");
    void downloadPromise.catch(() => {});
    send({ type: "ready" });
    const download = await downloadPromise;
    options.onMeasurement?.("download", download);
    const upload = await sendPhase("download");
    options.onMeasurement?.("upload", upload);
    return { upload, download, completedAt: Date.now() };
  } catch (error) {
    const failure =
      error instanceof SpeedTestError
        ? error
        : new SpeedTestError("failed");
    fail(failure);
    throw failure;
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener(
      "abort",
      onExternalAbort,
    );
    channel.removeEventListener("message", onMessage);
    channel.removeEventListener("close", onClose);
    channel.removeEventListener("error", onClose);
    fail(new SpeedTestError("cancelled"));
    signal.removeEventListener("abort", rejectPending);
    receiving = undefined;
    // close() is graceful: the last receipt drains before stream shutdown.
    channel.close();
  }
}
