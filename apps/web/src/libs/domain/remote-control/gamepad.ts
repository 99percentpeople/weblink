import { createUuid } from "../ids";
import type {
  GamepadState,
  GamepadStatus,
  GamepadFeedback,
  RemoteGamepadEvent,
} from "../protocol/remote-control/input-devices";
import {
  GamepadHaptics,
  type RumbleActuator,
} from "./gamepad-haptics";
import {
  resolveRemoteGamepadOptions,
  type RemoteGamepadOptions,
} from "./gamepad-options";

export type GamepadSample = Pick<
  Gamepad,
  | "index"
  | "id"
  | "connected"
  | "mapping"
  | "buttons"
  | "axes"
> & { vibrationActuator?: RumbleActuator | null };
type Pad = {
  id: string;
  source: string;
  slot: number;
  last?: string;
  at: number;
  failed: boolean;
  sample: GamepadSample;
  haptics: GamepadHaptics;
};

/** Samples are complete states. No input is buffered for replay after a pause. */
export class RemoteGamepads {
  private pads = new Map<number, Pad>();
  private options = resolveRemoteGamepadOptions(undefined);
  configure(options: RemoteGamepadOptions): void {
    const next = resolveRemoteGamepadOptions(options);
    if (!next.enabled) this.close();
    if (
      !next.vibration ||
      next.vibrationStrength !==
        this.options.vibrationStrength
    )
      for (const pad of this.pads.values())
        pad.haptics.stop();
    this.options = next;
  }
  feedback(feedback: GamepadFeedback): void {
    if (!this.options.enabled || !this.options.vibration)
      return;
    const pad = [...this.pads.values()].find(
      (p) =>
        p.slot === feedback.slot && p.id === feedback.id,
    );
    if (!pad || pad.failed) return;
    pad.haptics.play(
      pad.sample.vibrationActuator,
      feedback,
      this.options.vibrationStrength,
    );
  }
  constructor(
    private readonly send: (
      event: RemoteGamepadEvent,
    ) => boolean,
    private readonly slots: number,
    private readonly id = createUuid,
    private readonly failed: () => void = () => {},
  ) {}
  sample(
    samples: readonly (GamepadSample | null)[],
    now: number,
  ): void {
    if (!this.options.enabled) return;
    const current = new Map(
      samples
        .filter(
          (p): p is GamepadSample =>
            !!p && p.connected && p.mapping === "standard",
        )
        .map((p) => [p.index, p]),
    );
    for (const [index, pad] of this.pads) {
      if (current.get(index)?.id !== pad.source)
        this.disconnect(index);
    }
    for (const [index, sample] of current) {
      let pad = this.pads.get(index);
      if (!pad) {
        const used = new Set(
          [...this.pads.values()].map((p) => p.slot),
        );
        const slot = Array.from(
          { length: Math.min(4, this.slots) },
          (_, i) => i,
        ).find((i) => !used.has(i));
        if (slot === undefined) continue;
        pad = {
          id: this.id(),
          source: sample.id,
          slot,
          at: -Infinity,
          failed: false,
          sample,
          haptics: new GamepadHaptics(),
        };
        this.pads.set(index, pad);
        if (
          !this.send({
            type: "gamepad",
            action: "connect",
            slot,
            id: pad.id,
          })
        ) {
          this.pads.delete(index);
          return;
        }
      }
      pad.sample = sample;
      if (pad.failed) continue;
      const state = gamepadState(
        sample,
        this.options.deadZone,
      );
      const serialized = JSON.stringify(state);
      if (serialized === pad.last && now - pad.at < 100)
        continue;
      if (
        !this.send({
          type: "gamepad",
          action: "state",
          slot: pad.slot,
          id: pad.id,
          state,
        })
      )
        return;
      pad.last = serialized;
      pad.at = now;
    }
  }
  status(status: GamepadStatus): void {
    const pad = [...this.pads.values()].find(
      (p) => p.slot === status.slot && p.id === status.id,
    );
    if (pad && !status.mounted && !pad.failed) {
      pad.failed = true;
      pad.haptics.stop();
      this.failed();
    }
  }
  disconnect(index: number): void {
    const pad = this.pads.get(index);
    if (!pad) return;
    pad.haptics.stop();
    this.pads.delete(index);
    this.send({
      type: "gamepad",
      action: "disconnect",
      slot: pad.slot,
      id: pad.id,
    });
  }
  close(): void {
    for (const index of [...this.pads.keys()])
      this.disconnect(index);
  }
}

export function gamepadState(
  pad: GamepadSample,
  deadZone = 0.08,
): GamepadState {
  const bounded = (v: number | undefined, min: number) =>
    Number.isFinite(v) ? Math.max(min, Math.min(1, v!)) : 0;
  const axis = (index: number) => {
    const value = bounded(pad.axes[index], -1);
    return Math.abs(value) < deadZone
      ? 0
      : Math.round(value * 1000) / 1000;
  };
  return {
    buttons: pad.buttons
      .slice(0, 17)
      .reduce(
        (bits, button, i) =>
          bits | (button.pressed ? 1 << i : 0),
        0,
      ),
    axes: [axis(0), axis(1), axis(2), axis(3)],
    triggers: [
      bounded(pad.buttons[6]?.value, 0),
      bounded(pad.buttons[7]?.value, 0),
    ],
  };
}

/** The focused remote surface owns this polling lifetime, including PiP documents. */
export function captureGamepads(
  window: Window,
  controller: RemoteGamepads,
): () => void {
  const lifetime = new AbortController();
  let frame = 0;
  const poll = () => {
    if (
      !window.document.hidden &&
      window.document.hasFocus()
    ) {
      try {
        controller.sample(
          window.navigator.getGamepads?.() ?? [],
          window.performance.now(),
        );
      } catch {
        controller.close();
      }
    } else controller.close();
    frame = window.requestAnimationFrame(poll);
  };
  window.addEventListener(
    "gamepaddisconnected",
    (event) => controller.disconnect(event.gamepad.index),
    { signal: lifetime.signal },
  );
  window.addEventListener(
    "blur",
    () => controller.close(),
    { signal: lifetime.signal },
  );
  window.document.addEventListener(
    "visibilitychange",
    () => {
      if (window.document.hidden) controller.close();
    },
    { signal: lifetime.signal },
  );
  frame = window.requestAnimationFrame(poll);
  return () => {
    lifetime.abort();
    window.cancelAnimationFrame(frame);
    controller.close();
  };
}
