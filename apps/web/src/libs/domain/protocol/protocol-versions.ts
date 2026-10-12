import {
  validCurrentCapability,
  type CapabilityOffers,
  type PeerCapabilities,
} from "./capabilities";
import type { SessionMessage } from "./messages";

/** The capability-sync format is independent of feature protocol majors. */
export const CAPABILITY_SYNC_VERSION = 1 as const;

/** Only implemented handlers may be registered here. No legacy fallbacks. */
export const CURRENT_PROTOCOL_VERSIONS = {
  messaging: 1,
  files: 1,
  room: 1,
  screen: 1,
  control: 1,
  clipboard: 1,
  fileDrop: 1,
  speedTest: 1,
} as const;
export type PeerFeature =
  keyof typeof CURRENT_PROTOCOL_VERSIONS;

export function parseProtocolId(
  id: string,
): { service: string; version: number } | undefined {
  const match =
    /^([a-zA-Z][a-zA-Z0-9._/-]*)\/([1-9][0-9]*)$/.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[2])))
    return;
  return { service: match[1], version: Number(match[2]) };
}

/** Local typed descriptors describe the current implementation. Extensions may
 * use explicit versioned keys, provided their handlers implement those versions. */
export function advertiseCapabilities(
  local: PeerCapabilities,
): CapabilityOffers {
  return Object.fromEntries(
    Object.entries(local).map(([name, state]) => {
      const major = Object.hasOwn(
        CURRENT_PROTOCOL_VERSIONS,
        name,
      )
        ? CURRENT_PROTOCOL_VERSIONS[name as PeerFeature]
        : 1;
      return [
        parseProtocolId(name) ? name : `${name}/${major}`,
        state,
      ];
    }),
  );
}

/** Select the highest common implemented major once per connection. Withdrawal
 * disables it; a patch cannot switch an active connection to another handler. */
export class ProtocolNegotiation {
  private readonly selected = new Map<string, string>();

  select(
    local: readonly string[],
    remote: readonly string[],
  ): ReadonlyMap<string, string> {
    const offered = new Set(remote);
    const candidates = new Map<
      string,
      { id: string; version: number }
    >();
    for (const id of local) {
      const parsed = parseProtocolId(id);
      if (
        !parsed ||
        !offered.has(id) ||
        this.selected.has(parsed.service)
      )
        continue;
      if (
        (candidates.get(parsed.service)?.version ?? 0) <
        parsed.version
      )
        candidates.set(parsed.service, {
          id,
          version: parsed.version,
        });
    }
    for (const [service, candidate] of candidates)
      this.selected.set(service, candidate.id);
    const available = new Set(local);
    return new Map(
      [...this.selected].filter(
        ([, id]) => available.has(id) && offered.has(id),
      ),
    );
  }

  project(
    local: CapabilityOffers,
    remote: CapabilityOffers,
  ): PeerCapabilities {
    const result: PeerCapabilities = {};
    for (const [service, id] of this.select(
      Object.keys(local),
      Object.keys(remote),
    )) {
      // Built-ins have exactly one implementation in this release. Unknown major
      // payloads never run through a current-version validator or handler.
      if (
        Object.hasOwn(CURRENT_PROTOCOL_VERSIONS, service) &&
        id !==
          `${service}/${CURRENT_PROTOCOL_VERSIONS[service as PeerFeature]}`
      )
        continue;
      if (
        validCurrentCapability(service, remote[id]) &&
        validCurrentCapability(service, local[id])
      )
        result[service] = remote[id];
    }
    return result;
  }
}

/** Replies finish already-authorized operations, including during withdrawal.
 * Bootstrap/profile/stream metadata use the base connection contract. */
export function requiredMessageFeatures(
  type: SessionMessage["type"],
): readonly PeerFeature[] {
  switch (type) {
    case "send-text":
    case "read-text":
      return ["messaging"];
    case "room-capabilities":
    case "send-room-text":
      return ["room"];
    case "send-room-file":
    case "request-room-file":
      return ["room", "files"];
    case "send-file":
    case "request-file":
    case "resume-file":
    case "file-content-ready":
    case "request-shared-file":
    case "request-storage":
    case "storage-changed":
      return ["files"];
    case "send-clipboard":
      return ["clipboard"];
    case "remote-clipboard":
      return ["control", "clipboard"];
    case "remote-file-drop":
      return ["control", "fileDrop"];
    default:
      return [];
  }
}
