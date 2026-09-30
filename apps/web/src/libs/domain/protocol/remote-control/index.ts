/** Additive screen-control contract. Receiving this capability never grants input. */
export const REMOTE_CONTROL_MAX_BYTES = 4096;
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const CONTROL_LEASE_MS = 2000;

export interface ControlCapabilities {
  request: boolean;
  host: boolean;
}
export interface ControlTarget {
  /** Publication ID, never a raw Windows monitor/window identifier. */
  sourceId: string;
  mediaId: string;
  geometryRevision: string;
}
export type DenialReason =
  | "unsupported"
  | "busy"
  | "declined"
  | "expired"
  | "unavailable";
export type RevocationReason =
  | "local"
  | "disconnected"
  | "sourceChanged"
  | "expired"
  | "ended";
export type ControlSignal =
  | {
      type: "request";
      requestId: string;
      target: ControlTarget;
    }
  | {
      type: "grant";
      requestId: string;
      target: ControlTarget;
      grantId: string;
      leaseMs: number;
    }
  | {
      type: "deny";
      requestId: string;
      reason: DenialReason;
    }
  | { type: "cancel"; requestId: string }
  | {
      type: "revoke";
      grantId: string;
      reason: RevocationReason;
    };

export function controlId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(value)
  );
}
function record(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
export function controlTarget(
  value: unknown,
): value is ControlTarget {
  return (
    record(value) &&
    controlId(value.sourceId) &&
    controlId(value.mediaId) &&
    controlId(value.geometryRevision)
  );
}
export function sameControlTarget(
  a: ControlTarget,
  b: ControlTarget,
): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.mediaId === b.mediaId &&
    a.geometryRevision === b.geometryRevision
  );
}
export function parseControlCapabilities(
  value: unknown,
): ControlCapabilities | undefined {
  if (
    !record(value) ||
    typeof value.request !== "boolean" ||
    typeof value.host !== "boolean"
  )
    return;
  return { request: value.request, host: value.host };
}
export function canRequestControl(
  local: ControlCapabilities,
  remote?: ControlCapabilities,
): boolean {
  return local.request && remote?.host === true;
}
export function parseControlSignal(
  data: unknown,
): ControlSignal | undefined {
  if (
    typeof data !== "string" ||
    data.length > REMOTE_CONTROL_MAX_BYTES ||
    new TextEncoder().encode(data).length >
      REMOTE_CONTROL_MAX_BYTES
  )
    return;
  try {
    const value: unknown = JSON.parse(data);
    if (!record(value)) return;
    if (value.type === "revoke") {
      if (
        controlId(value.grantId) &&
        [
          "local",
          "disconnected",
          "sourceChanged",
          "expired",
          "ended",
        ].includes(value.reason as string)
      )
        return {
          type: "revoke",
          grantId: value.grantId,
          reason: value.reason as RevocationReason,
        };
      return;
    }
    if (!controlId(value.requestId)) return;
    if (value.type === "cancel")
      return { type: "cancel", requestId: value.requestId };
    if (value.type === "deny") {
      if (
        [
          "unsupported",
          "busy",
          "declined",
          "expired",
          "unavailable",
        ].includes(value.reason as string)
      )
        return {
          type: "deny",
          requestId: value.requestId,
          reason: value.reason as DenialReason,
        };
      return;
    }
    if (!controlTarget(value.target)) return;
    const target = {
      sourceId: value.target.sourceId,
      mediaId: value.target.mediaId,
      geometryRevision: value.target.geometryRevision,
    };
    if (value.type === "request")
      return {
        type: "request",
        requestId: value.requestId,
        target,
      };
    if (
      value.type === "grant" &&
      controlId(value.grantId) &&
      Number.isInteger(value.leaseMs) &&
      (value.leaseMs as number) >= 500 &&
      (value.leaseMs as number) <= 10_000
    )
      return {
        type: "grant",
        requestId: value.requestId,
        target,
        grantId: value.grantId,
        leaseMs: value.leaseMs as number,
      };
  } catch {
    /* Unknown/malformed messages cannot change authority. */
  }
}
