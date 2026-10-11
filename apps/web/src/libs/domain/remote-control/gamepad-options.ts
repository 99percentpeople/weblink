export interface RemoteGamepadOptions {
  enabled: boolean;
  vibration: boolean;
  vibrationStrength: number;
  deadZone: number;
}

export const defaultRemoteGamepadOptions: Readonly<RemoteGamepadOptions> =
  {
    enabled: true,
    vibration: true,
    vibrationStrength: 1,
    deadZone: 0.08,
  };

export function resolveRemoteGamepadOptions(
  value: unknown,
): RemoteGamepadOptions {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const bounded = (
    key: "vibrationStrength" | "deadZone",
    max: number,
  ) =>
    typeof v[key] === "number" && Number.isFinite(v[key])
      ? Math.max(0, Math.min(max, v[key]))
      : defaultRemoteGamepadOptions[key];
  return {
    enabled: v.enabled !== false,
    vibration: v.vibration !== false,
    vibrationStrength: bounded("vibrationStrength", 1),
    deadZone: bounded("deadZone", 0.5),
  };
}
