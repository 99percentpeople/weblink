import type { Plugin } from "vite";
import { BRAND_ASSETS } from "../src/branding/brand";
import { generateBrandAssets } from "./generate-brand-assets";

/** Keep dev, production builds and HTML icon links on the same assets. */
export function webLinkBranding(): Plugin {
  return {
    name: "weblink-branding",
    async configResolved(config) {
      await generateBrandAssets(config.root);
    },
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: BRAND_ASSETS.ico,
            sizes: "48x48",
          },
          injectTo: "head",
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: BRAND_ASSETS.favicon,
            type: "image/svg+xml",
            sizes: "any",
          },
          injectTo: "head",
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: BRAND_ASSETS.apple,
            sizes: "180x180",
          },
          injectTo: "head",
        },
      ],
    },
  };
}
