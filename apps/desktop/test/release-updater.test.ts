import { expect, it } from "vitest";
import {
  createUpdateManifest,
  createUpdaterConfig,
} from "../../../scripts/desktop-updater.mjs";

const input = {
  tag: "v1.1.0",
  version: "1.1.0",
  signature: "signed installer content\n",
  notes: "Release notes",
  publishedAt: "2026-10-13T00:00:00Z",
};

it("pins the signed installer to its version instead of the latest download URL", () => {
  expect(createUpdateManifest(input)).toEqual({
    version: "1.1.0",
    notes: "Release notes",
    pub_date: "2026-10-13T00:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        url: "https://github.com/99percentpeople/weblink/releases/download/v1.1.0/Weblink-windows-x64-setup.exe",
        signature: "signed installer content",
      },
    },
  });
});

it("rejects wrong versions, development tags, and missing signing output", () => {
  for (const changes of [
    { tag: "v1.2.0" },
    { tag: "v1.1.0-rc.1" },
    { signature: " " },
    { notes: "" },
    { publishedAt: "invalid" },
  ]) {
    expect(() =>
      createUpdateManifest({ ...input, ...changes }),
    ).toThrow();
  }
});

it("requires public key contents and generates only public build configuration", () => {
  expect(() => createUpdaterConfig(undefined)).toThrow(
    "PUBLIC_KEY",
  );
  expect(() =>
    createUpdaterConfig("/keys/updater.pub"),
  ).toThrow("contents");
  const key = Buffer.from(
    `untrusted comment: test public key\n${Buffer.alloc(42).toString("base64")}\n`,
  ).toString("base64");
  expect(createUpdaterConfig(key)).toEqual({
    build: { beforeBuildCommand: "" },
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: key } },
  });
});
