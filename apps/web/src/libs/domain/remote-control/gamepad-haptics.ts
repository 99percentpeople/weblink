import type { GamepadFeedback } from "../protocol/remote-control/input-devices";

/** Structural boundary also accommodates browsers without the newer effects property. */
export interface RumbleActuator {
  effects?: readonly string[];
  playEffect(
    type: "dual-rumble",
    params: GamepadEffectParameters,
  ): Promise<unknown>;
  reset(): Promise<unknown>;
}

export class GamepadHaptics {
  private actuator?: RumbleActuator;
  private failed?: RumbleActuator;
  private generation = 0;

  play(
    actuator: RumbleActuator | null | undefined,
    feedback: GamepadFeedback,
    strength: number,
  ): void {
    if (
      !actuator ||
      typeof actuator.playEffect !== "function" ||
      actuator === this.failed ||
      (actuator.effects &&
        !actuator.effects.includes("dual-rumble"))
    )
      return;
    if (
      !strength ||
      (!feedback.strongMagnitude && !feedback.weakMagnitude)
    ) {
      this.stop();
      return;
    }
    if (this.actuator && this.actuator !== actuator)
      this.stop();
    this.actuator = actuator;
    const generation = ++this.generation;
    const failed = () => {
      if (this.generation !== generation) return;
      this.failed = actuator;
      this.stop();
    };
    try {
      void Promise.resolve(
        actuator.playEffect("dual-rumble", {
          duration: feedback.duration,
          startDelay: 0,
          strongMagnitude:
            feedback.strongMagnitude * strength,
          weakMagnitude: feedback.weakMagnitude * strength,
        }),
      ).catch(failed);
    } catch {
      failed();
    }
  }

  stop(): void {
    ++this.generation;
    const actuator = this.actuator;
    this.actuator = undefined;
    if (!actuator) return;
    try {
      void Promise.resolve(actuator.reset()).catch(
        () => {},
      );
    } catch {
      /* Hardware duration still bounds vibration if the device disappears. */
    }
  }
}
