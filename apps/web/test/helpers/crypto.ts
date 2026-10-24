import { webcrypto } from "node:crypto";
import { vi } from "vitest";

/** LAN HTTP exposes secure randomness, but neither subtle nor randomUUID. */
export function useSoftwareCrypto(): void {
  vi.stubGlobal("crypto", {
    getRandomValues:
      webcrypto.getRandomValues.bind(webcrypto),
  });
}
