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

/** Unacknowledged positions are valid only inside an acknowledged hover operation. */
export interface FileDropPosition {
  operationId: string;
  grantId: string;
  sequence: number;
  point: { x: number; y: number };
}
const operationId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(v);
function validPoint(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return false;
  const point = v as Record<string, unknown>;
  return [point.x, point.y].every(
    (n) =>
      typeof n === "number" &&
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 1,
  );
}
export function validFileDropPosition(
  v: Record<string, unknown>,
): boolean {
  return (
    controlId(v.grantId) &&
    operationId(v.operationId) &&
    Number.isSafeInteger(v.sequence) &&
    (v.sequence as number) > 0 &&
    validPoint(v.point)
  );
}

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
  | {
      action: "hover";
      destination: ControlTarget;
      point: { x: number; y: number };
      /** MIME hints are available during dragging; file bytes are not. */
      types: string[];
    }
  | { action: "offer"; size: number }
  | { action: "cancel"; error?: string }
);
export function validFileDropRequest(
  v: Record<string, unknown>,
): boolean {
  if (v.action !== "hover" && v.types !== undefined)
    return false;
  if (!controlId(v.grantId) || !operationId(v.operationId))
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
  if (v.action === "hover") {
    if (
      !Array.isArray(v.types) ||
      v.types.length > 16 ||
      !v.types.every(
        (type) =>
          typeof type === "string" &&
          type.length <= 128 &&
          /^[a-zA-Z0-9!#$&^_.+\/-]*$/.test(type),
      )
    )
      return false;
  }
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
    (v.action !== "prepare" && v.action !== "hover") ||
    !controlTarget(v.destination) ||
    v.size !== undefined ||
    !validPoint(v.point)
  )
    return false;
  return true;
}
