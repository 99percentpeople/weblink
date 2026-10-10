import { controlId } from "./index";

export const INPUT_DEVICE_KINDS = [
  "keyboard",
  "mouse",
  "touchpad",
  "touchscreen",
  "gamepad",
] as const;
export interface RemoteInputCapability {
  kind: (typeof INPUT_DEVICE_KINDS)[number];
  availability:
    | "available"
    | "unsupported"
    | "driverRequired"
    | "unavailable";
  maxDevices: number;
}
/** Unknown/malformed extensions never enable injection on an older host. */
export function parseInputCapabilities(
  value: unknown,
): RemoteInputCapability[] {
  if (
    !Array.isArray(value) ||
    value.length > INPUT_DEVICE_KINDS.length
  )
    return [];
  const result: RemoteInputCapability[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !INPUT_DEVICE_KINDS.includes(item.kind) ||
      ![
        "available",
        "unsupported",
        "driverRequired",
        "unavailable",
      ].includes(item.availability) ||
      !Number.isInteger(item.maxDevices) ||
      item.maxDevices < 0 ||
      item.maxDevices > 4 ||
      result.some((c) => c.kind === item.kind)
    )
      return [];
    result.push({
      kind: item.kind,
      availability: item.availability,
      maxDevices: item.maxDevices,
    });
  }
  return result;
}

export interface GamepadState {
  buttons: number;
  axes: [number, number, number, number];
  triggers: [number, number];
}
export type RemoteGamepadEvent = {
  type: "gamepad";
  slot: number;
  /** Connection identity, distinct from the reusable browser index/player slot. */
  id: string;
} & (
  | { action: "connect" | "disconnect" }
  | { action: "state"; state: GamepadState }
);

export interface GamepadStatus {
  slot: number;
  id: string;
  mounted: boolean;
}

export interface GamepadFeedback {
  slot: number;
  id: string;
  strongMagnitude: number;
  weakMagnitude: number;
  /** A short renewable lease, never an unbounded effect. */
  duration: number;
}

export function parseGamepadFeedback(
  value: Record<string, unknown>,
): GamepadFeedback | undefined {
  const {
    slot,
    id,
    strongMagnitude,
    weakMagnitude,
    duration,
  } = value;
  if (
    typeof slot !== "number" ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= 4 ||
    !controlId(id) ||
    typeof strongMagnitude !== "number" ||
    !Number.isFinite(strongMagnitude) ||
    strongMagnitude < 0 ||
    strongMagnitude > 1 ||
    typeof weakMagnitude !== "number" ||
    !Number.isFinite(weakMagnitude) ||
    weakMagnitude < 0 ||
    weakMagnitude > 1 ||
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 500
  )
    return;
  return {
    slot,
    id,
    strongMagnitude,
    weakMagnitude,
    duration,
  };
}
