import keys from "./keys.json";

/** Physical key positions, matching KeyboardEvent.code; use control.text for characters. */
export type KeyName = keyof typeof keys;
type KeyTiming = {
  holdMs?: number;
  repeat?: number;
  intervalMs?: number;
};
export type KeyArguments = { target: string } & (
  | { action: "down" | "up"; key: KeyName }
  | ({ action: "press"; key: KeyName } & KeyTiming)
  | ({ action: "chord"; keys: KeyName[] } & KeyTiming)
);
export type TextArguments = {
  target: string;
  text: string;
  intervalMs?: number;
};
