import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateTransparentAsset } from "@vite-pwa/assets-generator/api";
import {
  BRAND_FILES,
  renderBrandSvg,
} from "@/branding/brand";

async function pixels(input: Buffer, size: number) {
  const image = await generateTransparentAsset(
    "none",
    input,
    size,
  );
  return image.raw().toBuffer({ resolveWithObject: true });
}

function publicFile(path: string): Buffer {
  return readFileSync(
    join(process.cwd(), "public", path.slice(1)),
  );
}

describe("brand raster outputs", () => {
  it("retains transparent circular corners only for ordinary icons", async () => {
    const icon = await pixels(
      publicFile(BRAND_FILES.pwa512),
      512,
    );
    expect(icon.info.channels).toBe(4);
    expect(icon.data[3]).toBe(0);
    expect(icon.data[(256 * 512 + 256) * 4 + 3]).toBe(255);
    for (const [path, size] of [
      [BRAND_FILES.maskable, 512],
      [BRAND_FILES.apple, 180],
    ] as const) {
      const image = await pixels(publicFile(path), size);
      let minimumAlpha = 255;
      for (
        let index = 3;
        index < image.data.length;
        index += 4
      ) {
        minimumAlpha = Math.min(
          minimumAlpha,
          image.data[index],
        );
      }
      expect(minimumAlpha).toBe(255);
    }
  });

  it("keeps all foreground strokes inside the maskable central safe circle", async () => {
    const foreground = renderBrandSvg("icon").replace(
      /<circle\b[^>]*\/>/,
      "",
    );
    const { data, info } = await pixels(
      Buffer.from(foreground),
      512,
    );
    let furthestPixel = 0;
    let visiblePixels = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * 4 + 3] > 8) {
          visiblePixels += 1;
          furthestPixel = Math.max(
            furthestPixel,
            Math.hypot(x + 0.5 - 256, y + 0.5 - 256),
          );
        }
      }
    }
    expect(visiblePixels).toBeGreaterThan(1000);
    // W3C App Manifest: the central circle of radius 40% is the safe zone.
    expect(furthestPixel).toBeLessThanOrEqual(512 * 0.4);
  });
});
