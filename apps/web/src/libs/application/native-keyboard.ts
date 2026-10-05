import type {
  NativeKeyboard,
  NativeKeyboardEvent,
  NativeKeyboardSession,
} from "@weblink/platform";
import type { RemoteKeyEvent } from "../domain/remote-control/keyboard";
import type { ExitControlShortcut } from "../domain/remote-control/keyboard-options";

export interface NativeKeyboardPort {
  clipboard?(action: "copy" | "paste"): boolean;
  current(): boolean;
  input(event: RemoteKeyEvent): boolean;
  reset(): void;
  cancel(): void;
  stopped(failed: boolean): void;
}
/** Own one focus/grant interval. Late startup/events can never migrate to another screen. */
export class NativeKeyboardForwarder {
  private closed = false;
  private session?: NativeKeyboardSession;
  private timer?: ReturnType<typeof setInterval>;
  private renewing = false;
  private sequence = 0;
  private readonly held = new Map<number, RemoteKeyEvent>();
  private readonly clipboardKeys = new Set<number>();
  constructor(
    api: NativeKeyboard,
    shortcut: ExitControlShortcut,
    private readonly port: NativeKeyboardPort,
  ) {
    void api
      .start(shortcut, (event) => this.receive(event))
      .then((session) => {
        if (this.closed || !port.current()) {
          void session.close().catch(() => {});
          this.stop();
          return;
        }
        this.session = session;
        this.timer = setInterval(() => {
          if (!port.current()) {
            this.stop();
            return;
          }
          if (this.renewing) return;
          this.renewing = true;
          void session
            .renew(this.sequence)
            .catch(() => this.fail(true))
            .finally(() => {
              this.renewing = false;
            });
        }, 200);
      })
      .catch(() => this.fail(true));
  }
  private receive(event: NativeKeyboardEvent): void {
    if (this.closed) return;
    if (!this.port.current()) {
      this.stop();
      return;
    }
    if (event.type === "stopped") {
      const exit =
        event.reason === "exit" ||
        event.reason === "emergency";
      this.stop();
      if (exit) this.port.cancel();
      this.port.stopped(
        event.reason === "expired" ||
          event.reason === "overflow",
      );
      return;
    }
    if (
      event.sequence !== this.sequence + 1 ||
      !Number.isFinite(event.timestamp) ||
      Math.abs(Date.now() - event.timestamp) > 100
    ) {
      this.fail(true);
      return;
    }
    this.sequence = event.sequence;
    const { scanCode, extended, down } = event;
    const key: RemoteKeyEvent = {
      type: "key",
      scanCode,
      extended,
      down,
    };
    const id = scanCode + (extended ? 256 : 0);
    if (this.clipboardKeys.has(id)) {
      if (!down) this.clipboardKeys.delete(id);
      return;
    }
    if (
      down &&
      !extended &&
      [0x2e, 0x2f].includes(scanCode) &&
      (this.held.has(0x1d) || this.held.has(0x11d)) &&
      ![0x38, 0x138, 0x2a, 0x36, 0x15b, 0x15c].some((id) =>
        this.held.has(id),
      ) &&
      this.port.clipboard?.(
        scanCode === 0x2e ? "copy" : "paste",
      )
    ) {
      this.clipboardKeys.add(id);
      for (const held of [...this.held.values()].reverse())
        this.port.input({ ...held, down: false });
      this.held.clear();
      return;
    }
    if (down) this.held.set(id, key);
    else this.held.delete(id);
    if (!this.port.input(key)) this.fail(true);
  }
  private fail(failed: boolean): void {
    if (this.closed) return;
    this.stop();
    this.port.reset();
    this.port.stopped(failed);
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // The peer transport enforces the original grant/epoch, even after focus changes.
    for (const event of [...this.held.values()].reverse()) {
      if (!this.port.input({ ...event, down: false }))
        break;
    }
    this.held.clear();
    void this.session?.close().catch(() => {});
    this.session = undefined;
  }
}
