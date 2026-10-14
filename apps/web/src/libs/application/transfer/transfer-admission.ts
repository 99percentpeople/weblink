import type { TransferQueue } from "./transfer-queue";

interface TransferAdmissionOptions {
  channel: RTCDataChannel;
  signal: AbortSignal;
  queue: TransferQueue;
  /** Acquire endpoint slots in client ID order to prevent bidirectional deadlocks. */
  first: boolean;
  initiator: boolean;
  sending: boolean;
  connected(): void;
  initialize(): Promise<void>;
  start(): void;
  closed(): void;
  failed(error: unknown): void;
}

/** Only used when both endpoints negotiated files.queue for this request.
 * Control requests are already acknowledged; queue time has no RPC/channel deadline.
 * The receiver installs its binary handler before allowing the sender to start.
 */
export function admitTransfer(
  options: TransferAdmissionOptions,
): void {
  const { channel, signal } = options;
  let requested = false;
  let helloSent = false;
  let peerHello = false;
  let localSlot = false;
  let peerSlot = false;
  let peerReady = false;
  let initializing = false;
  let initialized = false;
  let started = false;

  const send = (
    type:
      | "transfer-hello"
      | "transfer-slot"
      | "transfer-start",
  ) => channel.send(JSON.stringify({ type }));
  const hello = () => {
    if (helloSent) return;
    helloSent = true;
    send("transfer-hello");
  };
  const start = () => {
    if (
      started ||
      signal.aborted ||
      !initialized ||
      (options.sending && !peerReady)
    )
      return;
    started = true;
    channel.removeEventListener("message", onMessage);
    channel.removeEventListener("close", onClose);
    channel.removeEventListener("error", onError);
    options.start();
    if (!options.sending && !signal.aborted)
      send("transfer-start");
  };
  const initialize = async () => {
    if (
      initializing ||
      !peerHello ||
      !localSlot ||
      !peerSlot ||
      signal.aborted
    )
      return;
    initializing = true;
    await options.initialize();
    signal.throwIfAborted();
    initialized = true;
    start();
  };
  const acquire = async () => {
    if (requested || signal.aborted) return;
    requested = true;
    await options.queue.acquire(signal);
    signal.throwIfAborted();
    localSlot = true;
    send("transfer-slot");
    await initialize();
  };
  const failed = (error: unknown) => {
    if (!signal.aborted) options.failed(error);
  };
  const onMessage = (event: MessageEvent) => {
    try {
      const message: unknown =
        typeof event.data === "string"
          ? JSON.parse(event.data)
          : undefined;
      const type =
        message &&
        typeof message === "object" &&
        "type" in message
          ? message.type
          : undefined;
      if (type === "transfer-hello") {
        if (peerHello) return;
        peerHello = true;
        options.connected();
        hello();
        if (options.first || peerSlot)
          void acquire().catch(failed);
      } else if (type === "transfer-slot") {
        if (peerSlot) return;
        peerSlot = true;
        if (peerHello)
          void (requested ? initialize() : acquire()).catch(
            failed,
          );
      } else if (
        type === "transfer-start" &&
        options.sending
      ) {
        // Data channels may be unordered: start can arrive before slot.
        peerReady = true;
        start();
      } else
        throw new Error(
          "Invalid transfer admission message",
        );
    } catch (error) {
      failed(error);
    }
  };
  const onClose = () => options.closed();
  const onError = () =>
    failed(
      new Error("Transfer channel failed while queued"),
    );
  const onOpen = () => {
    // The creator may only receive its channel after an asynchronous open wait.
    // Wait for its hello before replying, so admission frames cannot be lost.
    if (options.initiator) hello();
  };
  channel.addEventListener("message", onMessage, {
    signal,
  });
  channel.addEventListener("close", onClose, { signal });
  channel.addEventListener("error", onError, { signal });
  if (channel.readyState === "open") onOpen();
  else
    channel.addEventListener("open", onOpen, {
      once: true,
      signal,
    });
}
