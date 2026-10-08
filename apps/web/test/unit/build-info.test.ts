// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createBuildInfo,
  buildInfoPlugin,
  resolveBuildChannel,
} from "../../scripts/build-info";

const commit = "abcdef1" + "2".repeat(33);
const builtAt = Date.UTC(2026, 8, 24);

describe("build channel metadata", () => {
  it.each([
    ["dev", undefined, "dev"],
    ["production", undefined, "stable"],
    ["desktop", undefined, "stable"],
    ["desktop", "dev", "dev"],
    ["desktop", "stable", "stable"],
  ] as const)(
    "resolves %s with channel %s to %s",
    (mode, override, expected) => {
      expect(resolveBuildChannel(mode, override)).toBe(
        expected,
      );
    },
  );

  it("rejects an invalid channel rather than silently omitting the dev commit", () => {
    expect(() =>
      resolveBuildChannel("desktop", "preview"),
    ).toThrow("WEBLINK_BUILD_CHANNEL");
  });

  it.each(["production", "desktop"])(
    "preserves the shared package version in %s",
    (mode) => {
      expect(
        createBuildInfo(
          "1.0.4",
          resolveBuildChannel(mode),
          commit,
          builtAt,
        ),
      ).toEqual({
        version: "1.0.4",
        channel: "stable",
        commit,
        builtAt: "2026-09-24T00:00:00.000Z",
      });
    },
  );

  it.each(["dev", "desktop"])(
    "identifies %s dev builds by their commit without changing package.json",
    (mode) => {
      expect(
        createBuildInfo(
          "1.0.4",
          resolveBuildChannel(mode, "dev"),
          commit,
          builtAt,
        ),
      ).toMatchObject({
        version: "1.0.4-dev.abcdef1",
        channel: "dev",
        commit,
      });
    },
  );

  it.each([undefined, "not-a-hash", "bad\nmetadata"])(
    "handles unavailable/invalid commit metadata (%s)",
    (hash) => {
      expect(
        createBuildInfo("1.0.4", "dev", hash, builtAt),
      ).toMatchObject({
        version: "1.0.4-dev.local",
        commit: null,
      });
    },
  );

  it.each(["production", "dev"])(
    "emits verifiable metadata and dev-only crawl exclusions in %s",
    (mode) => {
      const info = createBuildInfo(
        "1.0.4",
        resolveBuildChannel(mode),
        commit,
        builtAt,
      );
      const plugin = buildInfoPlugin(info);
      const assets = new Map<string, string>();
      const hook = plugin.generateBundle;
      if (typeof hook !== "function")
        throw new Error("Expected a bundle hook");
      hook.call(
        {
          emitFile: (asset: {
            fileName: string;
            source: string;
          }) => assets.set(asset.fileName, asset.source),
        } as never,
        {} as never,
        {},
        false,
      );

      expect(
        JSON.parse(assets.get("version.json")!),
      ).toEqual(info);
      expect(assets.get("_headers")).toContain(
        "Cache-Control: no-store",
      );
      if (mode === "dev") {
        expect(assets.get("_headers")).toContain(
          "X-Robots-Tag: noindex",
        );
        expect(assets.get("robots.txt")).toContain(
          "Disallow: /",
        );
      } else {
        expect(assets.get("_headers")).not.toContain(
          "noindex",
        );
        expect(assets.has("robots.txt")).toBe(false);
      }
    },
  );
});
