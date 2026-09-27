import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { instructions } from "@vite-pwa/assets-generator/api/instructions";
import {
  BRAND,
  BRAND_FILES,
  renderBrandSvg,
} from "../src/branding/brand";
import { brandPwaPreset } from "./brand-preset";

function writeIfChanged(
  path: string,
  value: string | Buffer,
): void {
  const next = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value);
  try {
    if (readFileSync(path).equals(next)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}

/** Synchronous so the existing PWA CLI can refresh sources while loading its config. */
export function writeBrandSvgAssets(root: string): void {
  const icon = renderBrandSvg("icon");
  const sources: Record<string, string> = {
    [BRAND_FILES.icon]: icon,
    [BRAND_FILES.favicon]: icon,
    [BRAND_FILES.faviconAlias]: icon,
    [BRAND_FILES.logo]: renderBrandSvg("logo"),
    [BRAND_FILES.logoLight]: renderBrandSvg(
      "logo",
      "wl-logo-light",
      BRAND.colors.textLight,
    ),
    [BRAND_FILES.logoDark]: renderBrandSvg(
      "logo",
      "wl-logo-dark",
      BRAND.colors.textDark,
    ),
    [BRAND_FILES.mark]: renderBrandSvg("mark"),
    [BRAND_FILES.inverse]: renderBrandSvg("inverse"),
    [BRAND_FILES.monochrome]: renderBrandSvg("monochrome"),
    [BRAND_FILES.pwaSource]: renderBrandSvg("pwa"),
  };
  for (const [path, svg] of Object.entries(sources)) {
    writeIfChanged(
      join(root, "public", path.slice(1)),
      svg,
    );
  }
}

export async function generateBrandAssets(
  root: string,
): Promise<void> {
  writeBrandSvgAssets(root);
  const assets = await instructions({
    imageResolver: () =>
      Buffer.from(renderBrandSvg("icon")),
    imageName: "favicon.svg",
    preset: brandPwaPreset,
    faviconPreset: "2023",
    htmlLinks: { xhtml: false, includeId: false },
    basePath: "/",
    resolveSvgName: () => "favicon.svg",
  });
  for (const group of [
    assets.favicon,
    assets.transparent,
    assets.maskable,
    assets.apple,
  ]) {
    for (const asset of Object.values(group)) {
      writeIfChanged(
        join(root, "public", asset.name),
        await asset.buffer(),
      );
    }
  }
  console.info(
    `[branding] ${BRAND.name} SVG, favicon and PWA assets are up to date.`,
  );
}
