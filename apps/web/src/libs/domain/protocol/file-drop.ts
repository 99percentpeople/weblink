import {
  controlId,
  controlTarget,
  type ControlTarget,
} from "./remote-control";
import {
  MAX_REMOTE_FILE_BYTES,
  remoteBundleLimit,
  validRemoteFileLimit,
} from "./remote-file-limits";

/** File payloads use the shared remote-content bundle and normal file channels. */
export type FileDropRequest = {
  operationId: string;
  grantId: string;
} & (
  | {
      action: "prepare";
      maxFileBytes?: number;
      destination: ControlTarget;
      point: { x: number; y: number };
    }
  | { action: "offer"; size: number }
  | { action: "cancel"; error?: string }
);
export function validFileDropRequest(
  v: Record<string, unknown>,
): boolean {
  if (
    !controlId(v.grantId) ||
    typeof v.operationId !== "string" ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(v.operationId)
  )
    return false;
  if (
    v.maxFileBytes !== undefined &&
    (v.action !== "prepare" ||
      !validRemoteFileLimit(v.maxFileBytes))
  )
    return false;
  if (v.action === "cancel")
    return (
      (v.error === undefined ||
        (typeof v.error === "string" &&
          v.error.length <= 1024)) &&
      v.destination === undefined &&
      v.point === undefined &&
      v.size === undefined
    );
  if (v.error !== undefined) return false;
  if (v.action === "offer")
    return (
      v.destination === undefined &&
      v.point === undefined &&
      Number.isSafeInteger(v.size) &&
      (v.size as number) > 4 &&
      (v.size as number) <=
        remoteBundleLimit(MAX_REMOTE_FILE_BYTES, false)
    );
  if (
    v.action !== "prepare" ||
    !controlTarget(v.destination) ||
    v.size !== undefined ||
    !v.point ||
    typeof v.point !== "object"
  )
    return false;
  const point = v.point as Record<string, unknown>;
  return [point.x, point.y].every(
    (n) =>
      typeof n === "number" &&
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 1,
  );
}
