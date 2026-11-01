import { expect, test } from "bun:test";
import { privateSdkRevision } from "../private-sdk-pin.mjs";

const revision = "a".repeat(40);
const binding = {
  git: "https://github.com/99percentpeople/rust-sdks.git",
  rev: revision,
};
const manifest = (first = binding, second = binding) => ({
  patch: {
    "crates-io": { libwebrtc: first, "webrtc-sys": second },
  },
});

test("selects the immutable source shared by both bindings", () => {
  expect(privateSdkRevision(manifest())).toBe(revision);
});

test("rejects missing, mutable, mixed and unexpected SDK sources", () => {
  for (const value of [
    {},
    manifest({}, binding),
    manifest(binding, { ...binding, rev: "b".repeat(40) }),
    manifest({ ...binding, rev: "main" }),
    manifest({ ...binding, rev: "a".repeat(7) }),
    manifest({
      ...binding,
      git: "https://example.com/sdk",
    }),
    ...["path", "branch", "tag"].map((key) =>
      manifest({ ...binding, [key]: "override" }),
    ),
  ]) {
    expect(() => privateSdkRevision(value)).toThrow();
  }
});
