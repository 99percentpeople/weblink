import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createUuid } from "@/libs/domain/ids";

afterEach(() => vi.unstubAllGlobals());

describe("UUID generation", () => {
  it("uses the native UUID API when available", () => {
    const id = "69f970b5-ce83-41d0-8d68-71d51a838462";
    const randomUUID = vi.fn(() => id);
    vi.stubGlobal("crypto", { randomUUID });

    expect(createUuid()).toBe(id);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses cryptographic random bytes on LAN HTTP pages without randomUUID", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, i) => i));
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(createUuid()).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
