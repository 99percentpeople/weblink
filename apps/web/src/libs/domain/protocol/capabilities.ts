import { controlId } from "./remote-control";
import {
  parseMediaDecodeCapabilities,
  type MediaDecodeCapabilities,
} from "./media-codecs";

/** Public occupancy only. Input grants and native handles never belong here. */
export type ControlOccupancy =
  | { state: "unavailable" | "idle" }
  | {
      /** Selected controller awaiting capture/native grant; unanswered requests stay idle. */
      state: "pending";
      clientId: string;
      sourceId: string | null;
    }
  | {
      state: "controlled";
      clientId: string;
      sourceId: string;
    };

export interface ControlCapability {
  request: boolean;
  host: boolean;
  occupancy: ControlOccupancy;
}

/** Negotiated descriptors for consumers. Only implemented entries are exposed. */
export interface PeerCapabilities {
  [service: string]: unknown;
  messaging?: Record<string, never>;
  fileDrop?: { hover?: boolean };
  files?: { content: boolean; shared: boolean };
  room?: { chat: boolean; files: boolean };
  screen?: {
    decode: MediaDecodeCapabilities;
    trickleIce: boolean;
    multiScreen: boolean;
  };
  control?: ControlCapability;
  clipboard?: { inlineText: boolean };
  speedTest?: { busy: boolean };
}
/** Versioned wire offers are opaque until the selected implementation validates them. */
export type CapabilityOffers = Record<string, unknown>;
export interface CapabilitySnapshot {
  kind: "snapshot";
  generation: string;
  revision: number;
  services: CapabilityOffers;
}
export type CapabilityChanges = Record<string, unknown>;
export type CapabilityAnnouncement =
  | CapabilitySnapshot
  | {
      kind: "patch";
      generation: string;
      revision: number;
      services: CapabilityChanges;
    };
export type CapabilityUpdate =
  | CapabilityAnnouncement
  | { kind: "request-snapshot" };

export const MAX_CAPABILITY_SERVICES = 32;
export const MAX_CAPABILITY_BYTES = 16 * 1024;

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const flags = (v: unknown, keys: string[]) =>
  record(v) &&
  keys.every((key) => typeof v[key] === "boolean");
export function validControlOccupancy(
  v: unknown,
): v is ControlOccupancy {
  return (
    record(v) &&
    (v.state === "idle" ||
      v.state === "unavailable" ||
      ((v.state === "pending" ||
        v.state === "controlled") &&
        controlId(v.clientId) &&
        (controlId(v.sourceId) ||
          (v.state === "pending" && v.sourceId === null))))
  );
}
const validators: Record<
  string,
  (value: unknown) => boolean
> = {
  messaging: (v) => record(v),
  fileDrop: (v) =>
    record(v) &&
    (v.hover === undefined || typeof v.hover === "boolean"),
  files: (v) => flags(v, ["content", "shared"]),
  room: (v) => flags(v, ["chat", "files"]),
  screen: (v) =>
    record(v) &&
    flags(v, ["trickleIce", "multiScreen"]) &&
    !!parseMediaDecodeCapabilities(v.decode),
  control: (v) =>
    record(v) &&
    flags(v, ["request", "host"]) &&
    validControlOccupancy(v.occupancy),
  speedTest: (v) => flags(v, ["busy"]),
  clipboard: (v) => flags(v, ["inlineText"]),
};

/** Validators belong to implemented major versions, never to future offers. */
export function validCurrentCapability(
  service: string,
  value: unknown,
): boolean {
  return (
    record(value) &&
    (!Object.hasOwn(validators, service) ||
      validators[service](value))
  );
}

export function validCapabilityUpdate(
  v: unknown,
): v is CapabilityUpdate {
  if (!record(v)) return false;
  if (v.kind === "request-snapshot")
    return Object.keys(v).length === 1;
  if (
    (v.kind !== "snapshot" && v.kind !== "patch") ||
    !controlId(v.generation) ||
    !Number.isSafeInteger(v.revision) ||
    (v.revision as number) < 0 ||
    !record(v.services) ||
    Object.keys(v.services).length >
      MAX_CAPABILITY_SERVICES * (v.kind === "patch" ? 2 : 1)
  )
    return false;
  const s = v.services;
  if (
    new TextEncoder().encode(JSON.stringify(v)).byteLength >
    MAX_CAPABILITY_BYTES
  )
    return false;
  return Object.entries(s).every(
    ([key, value]) =>
      /^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(key) &&
      !["constructor", "prototype"].includes(key) &&
      (value === null ? v.kind === "patch" : record(value)),
  );
}

/** Replace entire changed entries; null explicitly withdraws a service. */
export function changedCapabilities(
  previous: CapabilityOffers,
  next: CapabilityOffers,
): CapabilityChanges {
  const changes: CapabilityChanges = {};
  for (const key of new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ])) {
    if (
      JSON.stringify(previous[key]) !==
      JSON.stringify(next[key])
    )
      changes[key] = Object.hasOwn(next, key)
        ? next[key]
        : null;
  }
  return changes;
}

/** An existing grant still needs its exact native connection and input epoch. */
export function controlBlocked(
  status: ControlOccupancy | undefined,
  clientId: string,
): boolean {
  return (
    !status ||
    status.state === "unavailable" ||
    status.state === "controlled" ||
    (status.state === "pending" &&
      status.clientId !== clientId)
  );
}
