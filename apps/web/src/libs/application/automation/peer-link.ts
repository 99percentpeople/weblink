import {
  AutomationError,
  failure,
  parseCall,
  type ToolCall,
  type ToolResult,
} from "@weblink/automation";
const MAX = 6 * 1024 * 1024;
const encode = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(
      ...bytes.subarray(i, i + 8192),
    );
  return btoa(s);
};
const decode = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
interface Packet {
  sequence: number;
  from: string;
  kind: "call" | "result" | "cancel";
  id: string;
  call?: ToolCall;
  result?: ToolResult;
}
/** One ephemeral ECDH identity per ordered DataChannel; approval compares the transcript fingerprint. */
export class AutomationPeerLink {
  readonly lifetime = new AbortController();
  fingerprint = "";
  failure?: string;
  private local = "";
  private remote = "";
  private key?: CryptoKey;
  private pair?: CryptoKeyPair;
  private sendSequence = 0;
  private receiveSequence = 0;
  private receiving: Promise<void> = Promise.resolve();
  private queuedFrames = 0;
  private queuedCharacters = 0;
  private assemblyTimer?: ReturnType<typeof setTimeout>;
  private sending: Promise<void> = Promise.resolve();
  private assembly?: {
    id: string;
    parts: string[];
    count: number;
    bytes: number;
    at: number;
  };
  private pending = new Map<
    string,
    {
      resolve(result: ToolResult): void;
      timer: ReturnType<typeof setTimeout>;
      abort(): void;
    }
  >();
  private executing = new Map<string, AbortController>();
  private seen = new Set<string>();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private handshakeTimer: ReturnType<typeof setTimeout>;
  constructor(
    readonly channel: RTCDataChannel,
    private readonly invoke: (
      call: ToolCall,
      signal: AbortSignal,
    ) => Promise<ToolResult>,
    private readonly changed: () => void,
    private readonly disconnected: () => void,
  ) {
    void this.ready.catch(() => {});
    this.handshakeTimer = setTimeout(
      () => this.close(),
      10000,
    );
    channel.addEventListener("close", () => this.close(), {
      signal: this.lifetime.signal,
    });
    channel.addEventListener("error", () => this.close(), {
      signal: this.lifetime.signal,
    });
    channel.addEventListener(
      "message",
      (event) => {
        const data: unknown = event.data;
        // Bound frames before retaining them in the async decryption queue.
        if (
          typeof data !== "string" ||
          data.length > 18000 ||
          this.queuedFrames >= 4096 ||
          this.queuedCharacters + data.length >
            MAX * 1.4 * 4
        ) {
          this.failure = "RECEIVE_LIMIT";
          this.close();
          return;
        }
        this.queuedFrames++;
        this.queuedCharacters += data.length;
        this.receiving = this.receiving
          .then(() => {
            if (!this.lifetime.signal.aborted)
              return this.receive(data);
          })
          .catch((error) => {
            this.failure =
              error instanceof Error
                ? error.message
                : "TRANSPORT_FAILED";
            this.close();
          })
          .finally(() => {
            this.queuedFrames--;
            this.queuedCharacters -= data.length;
          });
      },
      { signal: this.lifetime.signal },
    );
    const start = () =>
      void this.hello().catch(() => this.close());
    if (channel.readyState === "open") start();
    else
      channel.addEventListener("open", start, {
        once: true,
        signal: this.lifetime.signal,
      });
  }
  private async hello(): Promise<void> {
    this.pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveKey"],
    );
    this.local = encode(
      new Uint8Array(
        await crypto.subtle.exportKey(
          "raw",
          this.pair.publicKey,
        ),
      ),
    );
    if (this.lifetime.signal.aborted) return;
    this.channel.send(
      JSON.stringify({ kind: "hello", key: this.local }),
    );
    if (this.remote) await this.derive();
  }
  private async derive(): Promise<void> {
    if (this.key || !this.pair) return;
    const remote = await crypto.subtle.importKey(
      "raw",
      decode(this.remote),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    this.key = await crypto.subtle.deriveKey(
      { name: "ECDH", public: remote },
      this.pair.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    this.fingerprint = hex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          [
            "weblink-automation/1",
            ...[this.local, this.remote].sort(),
          ].join("\n"),
        ),
      ),
    );
    clearTimeout(this.handshakeTimer);
    this.readyResolve();
    this.changed();
  }
  private async receive(data: unknown): Promise<void> {
    if (typeof data !== "string" || data.length > 18000)
      throw new Error("Invalid frame");
    const frame = JSON.parse(data);
    if (frame.kind === "hello") {
      if (
        this.remote ||
        typeof frame.key !== "string" ||
        frame.key.length > 128
      )
        throw new Error("Invalid hello");
      this.remote = frame.key;
      await this.derive();
      return;
    }
    if (
      !this.key ||
      frame.kind !== "chunk" ||
      typeof frame.id !== "string" ||
      frame.id.length > 40 ||
      !Number.isInteger(frame.index) ||
      !Number.isInteger(frame.count) ||
      frame.count < 1 ||
      frame.count > 700 ||
      typeof frame.data !== "string"
    )
      throw new Error("Invalid chunk");
    if (!this.assembly) {
      if (frame.index !== 0)
        throw new Error("Out of order");
      this.assembly = {
        id: frame.id,
        parts: [],
        count: frame.count,
        bytes: 0,
        at: Date.now(),
      };
      this.assemblyTimer = setTimeout(() => {
        this.failure = "ASSEMBLY_TIMEOUT";
        this.close();
      }, 30000);
    }
    const a = this.assembly;
    if (
      a.id !== frame.id ||
      frame.index !== a.parts.length ||
      frame.count !== a.count ||
      Date.now() - a.at > 30000
    )
      throw new Error("Invalid assembly");
    a.bytes += frame.data.length;
    if (a.bytes > MAX * 1.4) throw new Error("Oversize");
    a.parts.push(frame.data);
    if (a.parts.length !== a.count) return;
    clearTimeout(this.assemblyTimer);
    this.assemblyTimer = undefined;
    this.assembly = undefined;
    const bytes = decode(a.parts.join(""));
    if (bytes.length > MAX + 64)
      throw new Error("Oversize");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      this.key,
      bytes.slice(12),
    );
    const packet = JSON.parse(
      new TextDecoder().decode(plain),
    ) as Packet;
    if (
      packet.from !== this.remote ||
      packet.sequence !== this.receiveSequence + 1 ||
      typeof packet.id !== "string" ||
      packet.id.length > 128
    )
      throw new Error("Replay");
    this.receiveSequence = packet.sequence;
    if (packet.kind === "result") {
      const p = this.pending.get(packet.id);
      if (p) {
        this.pending.delete(packet.id);
        clearTimeout(p.timer);
        p.abort();
        p.resolve(
          packet.result ??
            failure(new AutomationError("INVALID_RESULT")),
        );
      }
      return;
    }
    if (packet.kind === "cancel") {
      this.executing.get(packet.id)?.abort();
      return;
    }
    if (packet.kind !== "call" || !packet.call)
      throw new Error("Invalid packet");
    if (this.seen.has(packet.id)) return;
    if (this.seen.size >= 10000) {
      this.close();
      return;
    }
    this.seen.add(packet.id);
    const call = packet.call;
    parseCall(call);
    if (call.arguments.target !== "local")
      throw new Error("Forwarding prohibited");
    if (this.executing.size >= 4) {
      void this.send({
        kind: "result",
        id: packet.id,
        result: failure(new AutomationError("BUSY")),
      });
      return;
    }
    const controller = new AbortController();
    this.executing.set(packet.id, controller);
    void this.invoke(call, controller.signal)
      .then(
        (result) =>
          this.send({
            kind: "result",
            id: packet.id,
            result,
          }),
        (error) =>
          this.send({
            kind: "result",
            id: packet.id,
            result: failure(error),
          }),
      )
      .catch(() => this.close())
      .finally(() => this.executing.delete(packet.id));
  }
  private send(
    packet: Omit<Packet, "sequence" | "from">,
  ): Promise<void> {
    const run = async () => {
      await this.ready;
      this.lifetime.signal.throwIfAborted();
      const raw = new TextEncoder().encode(
        JSON.stringify({
          ...packet,
          sequence: ++this.sendSequence,
          from: this.local,
        }),
      );
      if (raw.length > MAX)
        throw new AutomationError("RESULT_TOO_LARGE");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          this.key!,
          raw,
        ),
      );
      const bytes = new Uint8Array(12 + encrypted.length);
      bytes.set(iv);
      bytes.set(encrypted, 12);
      const text = encode(bytes),
        id = crypto.randomUUID(),
        count = Math.ceil(text.length / 12000);
      const deadline = Date.now() + 30000;
      for (let index = 0; index < count; index++) {
        while (this.channel.bufferedAmount > 128 * 1024) {
          this.lifetime.signal.throwIfAborted();
          if (Date.now() > deadline)
            throw new AutomationError("TIMEOUT");
          await new Promise((resolve) =>
            setTimeout(resolve, 20),
          );
        }
        this.lifetime.signal.throwIfAborted();
        this.channel.send(
          JSON.stringify({
            kind: "chunk",
            id,
            index,
            count,
            data: text.slice(
              index * 12000,
              (index + 1) * 12000,
            ),
          }),
        );
      }
    };
    const result = this.sending.then(run);
    this.sending = result.catch((error) => {
      this.failure =
        error instanceof Error
          ? error.message
          : "TRANSPORT_FAILED";
      this.close();
    });
    return result;
  }
  async call(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    await this.ready;
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.pending.size >= 4)
      throw new AutomationError("BUSY");
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.abort();
        resolve(failure(new AutomationError("CANCELLED")));
        void this.send({ kind: "cancel", id }).catch(
          () => {},
        );
      };
      const timer = setTimeout(cancel, 270000);
      this.pending.set(id, {
        resolve,
        timer,
        abort: () =>
          signal.removeEventListener("abort", cancel),
      });
      signal.addEventListener("abort", cancel, {
        once: true,
      });
      void this.send({ kind: "call", id, call }).catch(
        cancel,
      );
    });
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.assemblyTimer);
    this.readyReject(
      new AutomationError("TARGET_DISCONNECTED"),
    );
    this.channel.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.abort();
      p.resolve(
        failure(new AutomationError("TARGET_DISCONNECTED")),
      );
    }
    this.pending.clear();
    for (const c of this.executing.values()) c.abort();
    this.executing.clear();
    this.assembly = undefined;
    this.disconnected();
    this.changed();
  }
}
