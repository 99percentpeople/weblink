import { IDENTITY_CHANNEL } from "./crypto";
/** Only the discovery contract is allowed before pairing or when content reception is off. */
export const bootstrapMessage = (type: string) =>
  type === "peer-capabilities";
export function applicationChannel(
  label: string,
  protocol: string,
): boolean {
  return !(
    (label === "message" && protocol === "message") ||
    (label === IDENTITY_CHANNEL &&
      protocol === IDENTITY_CHANNEL)
  );
}
