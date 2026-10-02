import {
  defineConfig,
  loadEnv,
  type ESBuildOptions,
} from "vite";
import { fileURLToPath } from "node:url";
import { VitePWA } from "vite-plugin-pwa";
import solidPlugin from "vite-plugin-solid";
import type { VitePWAOptions } from "vite-plugin-pwa";
import solidSvg from "vite-plugin-solid-svg";
import { compression } from "vite-plugin-compression2";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import { webLinkBranding } from "./scripts/brand-plugin";
import {
  buildInfoPlugin,
  createBuildInfo,
  getBuildCommit,
} from "./scripts/build-info";
import {
  BRAND_ASSETS,
  BRAND_MANIFEST_ICONS,
  BRAND_REVISION,
} from "./src/branding/brand";
const packageJson = JSON.parse(
  readFileSync("./package.json", "utf-8"),
);
const envPrefix = ["VITE_", "WEBLINK_"];

function getBuildLoggingOptions(
  mode: string,
): ESBuildOptions {
  if (mode !== "production") return {};
  return {
    pure: ["console.log", "console.debug", "console.trace"],
    drop: ["debugger"],
  };
}

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

export default defineConfig(({ command, mode }) => {
  const desktop = mode === "desktop";
  const desktopEnv = desktop
    ? loadEnv(mode, process.cwd(), envPrefix)
    : {};
  const version = desktop
    ? JSON.parse(
        readFileSync(
          new URL(
            "../desktop/package.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ).version
    : packageJson.version;
  const buildInfo = createBuildInfo(
    version,
    mode,
    getBuildCommit(),
  );
  return {
    envPrefix,
    // Browser and desktop resolve different platform dependencies.
    cacheDir: `node_modules/.vite/${mode}`,
    resolve: {
      alias: {
        ...(desktop
          ? {
              "@/libs/platform/runtime": fileURLToPath(
                new URL(
                  "../desktop/src/platform.ts",
                  import.meta.url,
                ),
              ),
              "virtual:pwa-register": fileURLToPath(
                new URL(
                  "./src/libs/platform/no-service-worker.ts",
                  import.meta.url,
                ),
              ),
            }
          : {}),
        "@": fileURLToPath(
          new URL("./src", import.meta.url),
        ),
      },
    },
    server: {
      port: Number(process.env.WEBLINK_WEB_PORT || 5173),
      strictPort: true,
      watch: {
        ignored: ["**/.~tmp~/**"],
        atomic: 1000,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 50,
        },
      },
    },
    optimizeDeps: {
      // The browser fixtures use different aliases and dependency graphs.
      entries: ["index.html"],
      // Pre-bundle worker dependencies before their first use.
      include: [
        "hash-wasm",
        "fflate",
        "@noble/ciphers/aes.js",
      ],
    },
    build: {
      outDir: desktop ? "../desktop/dist" : "dist",
      emptyOutDir: true,
      target: desktop ? "chrome120" : undefined,
      rollupOptions: {
        treeshake: true,
      },
      minify: true,
    },
    plugins: [
      desktop && {
        name: "weblink-desktop-html",
        transformIndexHtml(html) {
          return html.replace(
            /<script>\s*window\.env\s*=[\s\S]*?<\/script>/,
            "",
          );
        },
      },
      webLinkBranding(),
      buildInfoPlugin(buildInfo),
      solidPlugin(),
      solidSvg({
        svgo: {
          enabled: true, // optional, by default is true
          svgoConfig: {
            plugins: ["preset-default", "removeDimensions"],
          },
        },
      }),
      !desktop &&
        VitePWA({
          ...pwaOptions,
          manifest: {
            ...(pwaOptions.manifest || {}),
            name:
              buildInfo.channel === "dev"
                ? "Weblink Dev"
                : "Weblink",
            short_name:
              buildInfo.channel === "dev"
                ? "Weblink Dev"
                : "Weblink",
          },
          integration: {
            // injectManifest runs its own Vite build instead of inheriting esbuild.
            configureCustomSWViteBuild(config) {
              config.esbuild = {
                ...(config.esbuild || {}),
                ...getBuildLoggingOptions(mode),
              };
            },
          },
        }),
      !desktop && compression(),
      tailwindcss(),
    ],
    esbuild: getBuildLoggingOptions(mode),
    define: {
      ...(desktop
        ? {
            "import.meta.env.VITE_WEBSOCKET_URL":
              JSON.stringify(
                desktopEnv.VITE_WEBSOCKET_URL ||
                  "wss://ws.webl.ink",
              ),
          }
        : {}),
      // Root .env configures local development without overriding builds.
      ...(command === "serve" &&
      process.env.WEBLINK_WEBSOCKET_URL
        ? {
            "import.meta.env.VITE_WEBSOCKET_URL":
              JSON.stringify(
                process.env.WEBLINK_WEBSOCKET_URL,
              ),
          }
        : {}),
      __APP_VERSION__: JSON.stringify(buildInfo.version),
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
      __APP_BUILD_TIME__: Date.parse(buildInfo.builtAt),
    },
  };
});
