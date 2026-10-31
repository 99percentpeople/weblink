import type { PreviewTrack } from "./preview-track";
import { ReceiveTiming } from "./receive-timing";

const SLOTS = 2;
export interface SharedEvent {
  additionalData?: {
    kind?: string;
    id?: string;
    slot?: number;
    slots?: number;
  };
  getBuffer(): ArrayBuffer;
}
export interface SharedWebview {
  addEventListener(
    type: "sharedbufferreceived",
    listener: (event: SharedEvent) => void,
  ): void;
  removeEventListener(
    type: "sharedbufferreceived",
    listener: (event: SharedEvent) => void,
  ): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}
export interface ReceiveFrame {
  type: "frame";
  slot: number;
  lease: number;
  frame: {
    sequence: number;
    width: number;
    height: number;
    format: "NV12" | "I420";
    colorSpace?: VideoColorSpaceInit | null;
  };
}

/** At most one writer and one replaceable pending frame. The raw native slot is
 * returned after VideoFrame's copying constructor, never after an arbitrary timer. */
export function createReceiveVideo(options: {
  id: string;
  webview: SharedWebview;
  presenter: PreviewTrack;
  visible(): boolean;
  returnSlots(
    releases: { slot: number; lease: number }[],
  ): void;
  mapped(): void;
  track(): void;
  fail(error: unknown): void;
}) {
  const { webview, presenter } = options;
  const buffers: (ArrayBuffer | undefined)[] = Array(SLOTS);
  const eventQueue = new ReceiveTiming();
  const construction = new ReceiveTiming();
  const write = new ReceiveTiming();
  let pending:
    | { event: ReceiveFrame; at: number }
    | undefined;
  let releases: { slot: number; lease: number }[] = [];
  let releaseScheduled = false;
  let initialized = false;
  let closed = false;
  let running = false;
  let tracked = false;
  let lastLease = 0;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let receivedFrames = 0,
    submittedFrames = 0,
    coalescedFrames = 0,
    hiddenFrames = 0,
    releaseMessages = 0,
    refreshFrames = 0;
  const release = ({ slot, lease }: ReceiveFrame) => {
    releases.push({ slot, lease });
    if (releaseScheduled) return;
    releaseScheduled = true;
    queueMicrotask(() => {
      releaseScheduled = false;
      const batch = releases;
      releases = [];
      if (closed || !batch.length) return;
      try {
        // The native bridge accepts this notification without a response or
        // a registered JS callback. No slot return waits on a pull RPC.
        for (
          let offset = 0;
          offset < batch.length;
          offset += SLOTS
        ) {
          options.returnSlots(
            batch.slice(offset, offset + SLOTS),
          );
          releaseMessages++;
        }
      } catch (error) {
        options.fail(error);
      }
    });
  };
  const discard = () => {
    if (pending) {
      release(pending.event);
      pending = undefined;
    }
  };
  const pump = async () => {
    if (
      closed ||
      !initialized ||
      running ||
      !options.visible()
    )
      return;
    running = true;
    clearTimeout(refresh);
    try {
      const next = pending;
      pending = undefined;
      if (next) {
        const { frame, slot } = next.event;
        const buffer = buffers[slot];
        if (
          !buffer ||
          buffer.byteLength <
            (frame.width * frame.height * 3) / 2
        )
          throw new Error(
            "Native receive slot is unavailable",
          );
        eventQueue.record(performance.now() - next.at);
        let pixels: VideoFrame;
        const creating = performance.now();
        try {
          // Persistent slots must be copied, not transferred. A transferred
          // WebView2 buffer can remain aliased by Chromium's retained frames;
          // returning its lease here would let native writes change old frames.
          pixels = new VideoFrame(buffer, {
            format: frame.format,
            codedWidth: frame.width,
            codedHeight: frame.height,
            timestamp: Math.round(performance.now() * 1000),
            colorSpace: frame.colorSpace ?? undefined,
          });
          construction.record(performance.now() - creating);
        } finally {
          // No transfer list: WebCodecs copies BufferSource data synchronously.
          // Native ownership is released only after that constructor returns.
          release(next.event);
        }
        const writing = performance.now();
        try {
          await presenter.write(pixels);
        } finally {
          pixels.close();
          write.record(performance.now() - writing);
        }
        if (!closed) {
          submittedFrames++;
          if (!tracked) {
            tracked = true;
            options.track();
          }
        }
      } else if (
        presenter.needsRefresh &&
        (await presenter.refresh())
      )
        refreshFrames++;
    } catch (error) {
      options.fail(error);
    } finally {
      running = false;
      if (!closed && options.visible()) {
        if (pending) queueMicrotask(() => void pump());
        else if (presenter.needsRefresh)
          refresh = setTimeout(() => void pump(), 500);
      }
    }
  };
  return {
    received(event: SharedEvent) {
      const metadata = event.additionalData;
      if (
        metadata?.kind !== "weblink-receive" ||
        metadata.id !== options.id
      )
        return;
      const buffer = event.getBuffer();
      const slot = metadata.slot;
      if (closed) {
        webview.releaseBuffer(buffer);
        return;
      }
      if (
        metadata.slots !== SLOTS ||
        !Number.isInteger(slot) ||
        slot! < 0 ||
        slot! >= SLOTS
      ) {
        webview.releaseBuffer(buffer);
        options.fail(
          new Error("Invalid native receive buffer pool"),
        );
        return;
      }
      if (buffers[slot!]) {
        if (buffers[slot!] !== buffer)
          webview.releaseBuffer(buffer);
        return;
      }
      buffers[slot!] = buffer;
      if (buffers.filter(Boolean).length === SLOTS)
        options.mapped();
    },
    frame(event: ReceiveFrame) {
      if (closed) return;
      const frame = event.frame;
      if (
        !Number.isInteger(event.slot) ||
        event.slot < 0 ||
        event.slot >= SLOTS ||
        !Number.isSafeInteger(event.lease) ||
        event.lease < 1 ||
        !frame ||
        !Number.isSafeInteger(frame.sequence) ||
        frame.sequence < 1 ||
        !Number.isInteger(frame.width) ||
        !Number.isInteger(frame.height) ||
        frame.width < 2 ||
        frame.height < 2 ||
        frame.width > 3840 ||
        frame.height > 2160 ||
        frame.width % 2 ||
        frame.height % 2 ||
        !["NV12", "I420"].includes(frame.format)
      ) {
        options.fail(
          new Error("Invalid native receive frame"),
        );
        return;
      }
      if (event.lease <= lastLease) return;
      lastLease = event.lease;
      receivedFrames++;
      if (!options.visible()) {
        hiddenFrames++;
        release(event);
        return;
      }
      if (pending) {
        coalescedFrames++;
        discard();
      }
      pending = { event, at: performance.now() };
      void pump();
    },
    start() {
      initialized = true;
      if (pending) void pump();
    },
    visibilityChanged() {
      if (!options.visible()) {
        clearTimeout(refresh);
        discard();
      } else if (pending || tracked) void pump();
    },
    stats() {
      return {
        implementation: presenter.implementation,
        receivedFrames,
        submittedFrames,
        coalescedFrames,
        hiddenFrames,
        releaseMessages,
        refreshFrames,
        eventQueueMs: eventQueue.read(),
        videoFrameCreateMs: construction.read(),
        presenterWriteMs: write.read(),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      pending = undefined;
      releases = [];
      clearTimeout(refresh);
      presenter.close();
      for (let i = 0; i < buffers.length; i++) {
        if (buffers[i]) webview.releaseBuffer(buffers[i]!);
        buffers[i] = undefined;
      }
    },
  };
}
