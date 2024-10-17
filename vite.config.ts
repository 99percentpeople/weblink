import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solidPlugin from "vite-plugin-solid";
import type { VitePWAOptions } from "vite-plugin-pwa";
import solidSvg from "vite-plugin-solid-svg";
import { compression } from "vite-plugin-compression2";
const pwaOptions: Partial<VitePWAOptions> = {
  mode:
    process.env.NODE_ENV === "development"
      ? "development"
      : "production",
  registerType: "autoUpdate",
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
    icons: [
      {
        src: "pwa-64x64.png",
        sizes: "64x64",
        type: "image/png",
      },
      {
        src: "pwa-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "pwa-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "maskable-icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  },
  base: "/",
  workbox: {},
  injectManifest: { swSrc: "src/sw.ts" },
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
  build: {
    rollupOptions: {
      treeshake: true,
    },
  },
  // optimizeDeps: {
  //   exclude: ["@mapbox"],
  // },

  plugins: [
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
  ],
  esbuild: {},
});
