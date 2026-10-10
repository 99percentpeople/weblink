/** Native host capabilities, independent of the operating system and transport. */
export type InputDeviceKind =
  | "keyboard"
  | "mouse"
  | "touchpad"
  | "touchscreen"
  | "gamepad";

export interface InputDeviceCapability {
  kind: InputDeviceKind;
  availability:
    | "available"
    | "unsupported"
    | "driverRequired"
    | "unavailable";
  maxDevices: number;
  driver?: {
    name: string;
    installUrl: string;
    maintenance: "maintained" | "retired";
  };
}

export interface InputDeviceSnapshot {
  capabilities: InputDeviceCapability[];
  /** Logical ownership; system injection need not create a physical HID device. */
  mounted: {
    kind: InputDeviceKind;
    slot: number;
    state: "mounted" | "suspended" | "failed";
  }[];
}
