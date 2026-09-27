import { defineConfig } from "@vite-pwa/assets-generator/config";
import { brandPwaPreset } from "./scripts/brand-preset";
import { writeBrandSvgAssets } from "./scripts/generate-brand-assets";

// `bun run generate-pwa-assets` always refreshes the shared SVG sources first.
writeBrandSvgAssets(process.cwd());

export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: brandPwaPreset,
  images: ["public/favicon.svg"],
});
