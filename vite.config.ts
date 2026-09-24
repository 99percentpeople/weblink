import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solidPlugin from "vite-plugin-solid";
import type { VitePWAOptions } from "vite-plugin-pwa";
import solidSvg from "vite-plugin-solid-svg";
import { compression } from "vite-plugin-compression2";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import { webLinkBranding } from "./scripts/brand-plugin";
import {
  BRAND_ASSETS,
  BRAND_MANIFEST_ICONS,
  BRAND_REVISION,
} from "./src/branding/brand";
const packageJson = JSON.parse(
  readFileSync("./package.json", "utf-8"),
);

const pwaOptions: Partial<VitePWAOptions> = {
  mode:
    process.env.NODE_ENV === "development"
      ? "development"
      : "production",
  registerType: "prompt",
  srcDir: "src",
  filename: "sw.ts",
  injectRegister: "auto",
  strategies: "injectManifest",
  manifest: {
    name: "Weblink",
    short_name: "Weblink",
    theme_color: "#ffffff",
    start_url: "/",
    display: "standalone",
    icons: BRAND_MANIFEST_ICONS,
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "name",
        text: "description",
        url: "link",
        files: [
          {
            name: "files",
            accept: ["*/*"],
          },
        ],
      },
    },
  },
  base: "/",
  injectManifest: {
    swSrc: "src/sw.ts",
    // Cache the exact versioned URLs used in the HTML and manifest.
    additionalManifestEntries: Object.values(
      BRAND_ASSETS,
    ).map((url) => ({
      url,
      revision: BRAND_REVISION,
    })),
  },
  devOptions: {
    enabled: false,
    /* when using generateSW the PWA plugin will switch to classic */
    type: "module",
    navigateFallback: "index.html",
  },
};

export default defineConfig({
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {},
  optimizeDeps: {
    // Pre-bundle worker dependencies before their first use.
    include: ["hash-wasm", "fflate"],
  },
  build: {
    rollupOptions: {
      treeshake: true,
    },
    minify: true,
  },
  plugins: [
    webLinkBranding(),
    solidPlugin(),
    solidSvg({
      svgo: {
        enabled: true, // optional, by default is true
        svgoConfig: {
          plugins: ["preset-default", "removeDimensions"],
        },
      },
    }),
    VitePWA(pwaOptions),
    compression(),
    tailwindcss(),
  ],
  esbuild: {},
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_LICENSE__: JSON.stringify(packageJson.license),
    __APP_AUTHOR_NAME__: JSON.stringify(
      packageJson.author.name,
    ),
    __APP_AUTHOR_EMAIL__: JSON.stringify(
      packageJson.author.email,
    ),
    __APP_AUTHOR_URL__: JSON.stringify(
      packageJson.author.url,
    ),
    __APP_BUILD_TIME__: Date.now(),
  },
});
