import { minimal2023Preset } from "@vite-pwa/assets-generator/config";
import type { Preset } from "@vite-pwa/assets-generator/config";
import { BRAND } from "../src/branding/brand";

/** No extra padding: the approved SVG already contains its safe area. */
export const brandPwaPreset: Preset = {
  ...minimal2023Preset,
  transparent: {
    ...minimal2023Preset.transparent,
    padding: 0,
  },
  maskable: {
    ...minimal2023Preset.maskable,
    padding: 0,
    resizeOptions: {
      fit: "contain",
      background: BRAND.colors.backgroundEnd,
    },
  },
  apple: {
    ...minimal2023Preset.apple,
    padding: 0,
    resizeOptions: {
      fit: "contain",
      background: BRAND.colors.backgroundEnd,
    },
  },
};
