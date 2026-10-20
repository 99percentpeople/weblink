import type { PeerTrustService } from "@/libs/application/peer-trust";

// Keep UI doubles aligned with the complete public service contract. Adding or
// changing a method must fail type-checking here instead of breaking a dialog.
type PeerTrustApi = Pick<
  PeerTrustService,
  keyof PeerTrustService
>;

export function createPeerTrustMock(
  overrides: Partial<PeerTrustApi> = {},
): PeerTrustApi {
  const unexpected = () => {
    throw new Error("Unexpected device trust action");
  };
  const service: PeerTrustApi = {
    get: () => undefined,
    trusted: (id) => service.get(id)?.state === "trusted",
    pairing: () => undefined,
    requestPairing: async () => unexpected(),
    respondPairing: unexpected,
    cancelPairing: unexpected,
    bind: unexpected,
    ...overrides,
  };
  return service;
}
