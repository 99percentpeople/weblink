// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Brand } from "@/components/common/brand";
import {
  BRAND,
  BRAND_ASSETS,
  BRAND_FILES,
  BRAND_MANIFEST_ICONS,
  BRAND_REVISION,
  renderBrandSvg,
} from "@/branding/brand";

afterEach(cleanup);

function parseSvg(value: string): Document {
  const document = new DOMParser().parseFromString(
    value,
    "image/svg+xml",
  );
  expect(document.querySelector("parsererror")).toBeNull();
  return document;
}

function publicPath(path: string): string {
  return join(
    process.cwd(),
    "public",
    path.replace(/^\//, ""),
  );
}

describe("shared Weblink branding", () => {
  it("keeps the approved circular icon and transparent outer corners", () => {
    const svg = parseSvg(
      renderBrandSvg("icon"),
    ).documentElement;
    const children = Array.from(svg.children);
    const background = children.find(
      (node) => node.tagName === "circle",
    );
    expect(background?.getAttribute("cx")).toBe("256");
    expect(background?.getAttribute("r")).toBe(
      String(BRAND.circleRadius),
    );
    expect(
      children.some((node) => node.tagName === "rect"),
    ).toBe(false);
    expect(svg.querySelectorAll("g > path")).toHaveLength(
      2,
    );
  });

  it("keeps the banner background-free and the entire wordmark currentColor", () => {
    const svg = parseSvg(
      renderBrandSvg("logo"),
    ).documentElement;
    const text = svg.querySelector("text");
    expect(text?.textContent).toBe(BRAND.name);
    expect(text?.getAttribute("fill")).toBe("currentColor");
    expect(text?.getAttribute("font-family")).toContain(
      "Inter Variable",
    );
    expect(svg.querySelector("circle")).toBeNull();
    expect(svg.querySelectorAll("text")).toHaveLength(1);
    expect(svg.querySelector("tspan")).toBeNull();
  });

  it("adds only an opaque outer background to the platform variant", () => {
    const svg = parseSvg(
      renderBrandSvg("pwa"),
    ).documentElement;
    expect(
      Array.from(svg.children)
        .find((node) => node.tagName === "rect")
        ?.getAttribute("fill"),
    ).toBe(BRAND.colors.backgroundEnd);
    expect(
      svg
        .querySelectorAll("g > path")[0]
        ?.getAttribute("d"),
    ).toBe(BRAND.paths[0]);
  });

  it("uses independent gradient and mask IDs for simultaneous component instances", () => {
    const { container } = render(() => (
      <>
        <Brand />
        <Brand variant="icon" />
        <Brand />
      </>
    ));
    const elements = Array.from(
      container.querySelectorAll("[id]"),
    );
    const ids = elements.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of Array.from(
      container.querySelectorAll("svg"),
    )) {
      const referenced = [
        ...svg.innerHTML.matchAll(/url\(#([^)]+)\)/g),
      ];
      for (const [, id] of referenced) {
        expect(
          Array.from(svg.querySelectorAll("[id]")).some(
            (node) => node.id === id,
          ),
        ).toBe(true);
      }
    }
  });

  it("provides a name by default and allows decorative usage", () => {
    const { container, getByRole } = render(() => (
      <>
        <Brand />
        <Brand variant="icon" decorative />
      </>
    ));
    expect(
      getByRole("img", { name: "Weblink" }),
    ).toBeTruthy();
    expect(
      container
        .querySelector('[data-brand-variant="icon"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("keeps generated SVGs and compatibility aliases identical to the shared source", () => {
    for (const key of [
      "icon",
      "favicon",
      "faviconAlias",
    ] as const) {
      expect(
        readFileSync(publicPath(BRAND_FILES[key]), "utf8"),
      ).toBe(renderBrandSvg("icon"));
    }
    expect(
      readFileSync(publicPath(BRAND_FILES.logo), "utf8"),
    ).toBe(renderBrandSvg("logo"));
    for (const path of Object.values(BRAND_FILES).filter(
      (path) => path.endsWith(".svg"),
    )) {
      parseSvg(readFileSync(publicPath(path), "utf8"));
    }
  });

  it("resolves every versioned URL and manifest icon to a generated file", () => {
    for (const url of Object.values(BRAND_ASSETS)) {
      const parsed = new URL(url, "https://example.test");
      expect(parsed.searchParams.get("v")).toBe(
        BRAND_REVISION,
      );
      expect(existsSync(publicPath(parsed.pathname))).toBe(
        true,
      );
    }
    for (const icon of BRAND_MANIFEST_ICONS) {
      expect(Object.values(BRAND_ASSETS)).toContain(
        icon.src,
      );
    }
  });

  it("generates the declared PNG sizes and a valid ICO header", () => {
    const expected: [string, number][] = [
      [BRAND_FILES.pwa64, 64],
      [BRAND_FILES.pwa192, 192],
      [BRAND_FILES.pwa512, 512],
      [BRAND_FILES.maskable, 512],
      [BRAND_FILES.apple, 180],
    ];
    for (const [path, size] of expected) {
      const png = readFileSync(publicPath(path));
      expect(png.subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    const ico = readFileSync(publicPath(BRAND_FILES.ico));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThan(0);
  });
});
