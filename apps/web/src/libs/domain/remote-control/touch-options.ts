export type TouchMode = "trackpad" | "direct";
export type LongPressAction =
  | "drag"
  | "right-click"
  | "none";
export type ThreeFingerTapAction = "keyboard" | "none";
export interface RemoteTouchOptions {
  mode: TouchMode;
  pointerSpeed: number;
  scrollSpeed: number;
  tapToClick: boolean;
  twoFingerRightClick: boolean;
  twoFingerScroll: boolean;
  naturalScroll: boolean;
  longPress: LongPressAction;
  threeFingerTap: ThreeFingerTapAction;
}
export const defaultRemoteTouchOptions: Readonly<RemoteTouchOptions> =
  {
    mode: "trackpad",
    pointerSpeed: 1,
    scrollSpeed: 1,
    tapToClick: true,
    twoFingerRightClick: true,
    twoFingerScroll: true,
    naturalScroll: true,
    longPress: "drag",
    threeFingerTap: "keyboard",
  };
/** Stored preferences are untrusted and older clients may omit new fields. */
export function resolveRemoteTouchOptions(
  value: unknown,
): RemoteTouchOptions {
  const defaults = defaultRemoteTouchOptions;
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const number = (
    key: "pointerSpeed" | "scrollSpeed",
    min: number,
    max: number,
  ) =>
    typeof v[key] === "number" && Number.isFinite(v[key])
      ? Math.min(max, Math.max(min, v[key]))
      : defaults[key];
  const boolean = (
    key:
      | "tapToClick"
      | "twoFingerRightClick"
      | "twoFingerScroll"
      | "naturalScroll",
  ) =>
    typeof v[key] === "boolean" ? v[key] : defaults[key];
  return {
    mode: v.mode === "direct" ? "direct" : "trackpad",
    pointerSpeed: number("pointerSpeed", 0.25, 3),
    scrollSpeed: number("scrollSpeed", 0.25, 3),
    tapToClick: boolean("tapToClick"),
    twoFingerRightClick: boolean("twoFingerRightClick"),
    twoFingerScroll: boolean("twoFingerScroll"),
    naturalScroll: boolean("naturalScroll"),
    threeFingerTap:
      v.threeFingerTap === "none" ? "none" : "keyboard",
    longPress:
      v.longPress === "right-click" ||
      v.longPress === "none"
        ? v.longPress
        : "drag",
  };
}
