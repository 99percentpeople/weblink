// vite.config.ts
import { defineConfig } from "file:///C:/Users/zachy/Desktop/weblink/node_modules/.pnpm/vite@5.4.8_@types+node@22.7.4_terser@5.34.1/node_modules/vite/dist/node/index.js";
import { VitePWA } from "file:///C:/Users/zachy/Desktop/weblink/node_modules/.pnpm/vite-plugin-pwa@0.20.5_@vite-pwa+assets-generator@0.2.6_vite@5.4.8_@types+node@22.7.4_terser@_ovbasw4ys4fzyortrjs5hglj2q/node_modules/vite-plugin-pwa/dist/index.js";
import solidPlugin from "file:///C:/Users/zachy/Desktop/weblink/node_modules/.pnpm/vite-plugin-solid@2.10.2_@testing-library+jest-dom@6.5.0_solid-js@1.9.1_vite@5.4.8_@types+node@22.7.4_terser@5.34.1_/node_modules/vite-plugin-solid/dist/esm/index.mjs";
import solidSvg from "file:///C:/Users/zachy/Desktop/weblink/node_modules/.pnpm/vite-plugin-solid-svg@0.8.1_solid-js@1.9.1_vite@5.4.8_@types+node@22.7.4_terser@5.34.1_/node_modules/vite-plugin-solid-svg/dist/index.js";
var pwaOptions = {
  mode: process.env.NODE_ENV === "development" ? "development" : "production",
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
        type: "image/png"
      },
      {
        src: "pwa-192x192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "pwa-512x512.png",
        sizes: "512x512",
        type: "image/png"
      },
      {
        src: "maskable-icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  },
  base: "/",
  workbox: {},
  injectManifest: { swSrc: "src/sw.ts" },
  devOptions: {
    enabled: false,
    /* when using generateSW the PWA plugin will switch to classic */
    type: "module",
    navigateFallback: "index.html"
  }
};
var vite_config_default = defineConfig({
  resolve: {
    alias: {
      "@": "/src"
    }
  },
  build: {
    rollupOptions: {
      treeshake: true
      // 确保启用tree-shaking
    }
  },
  // optimizeDeps: {
  //   exclude: ["@mapbox"],
  // },
  plugins: [
    solidPlugin(),
    solidSvg({
      svgo: {
        enabled: true,
        // optional, by default is true
        svgoConfig: {
          plugins: ["preset-default", "removeDimensions"]
        }
      }
    }),
    VitePWA(pwaOptions)
  ],
  esbuild: {}
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFx6YWNoeVxcXFxEZXNrdG9wXFxcXHdlYmxpbmtcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXHphY2h5XFxcXERlc2t0b3BcXFxcd2VibGlua1xcXFx2aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vQzovVXNlcnMvemFjaHkvRGVza3RvcC93ZWJsaW5rL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcclxuaW1wb3J0IHsgVml0ZVBXQSB9IGZyb20gXCJ2aXRlLXBsdWdpbi1wd2FcIjtcclxuaW1wb3J0IHNvbGlkUGx1Z2luIGZyb20gXCJ2aXRlLXBsdWdpbi1zb2xpZFwiO1xyXG5pbXBvcnQgdHlwZSB7IFZpdGVQV0FPcHRpb25zIH0gZnJvbSBcInZpdGUtcGx1Z2luLXB3YVwiO1xyXG5pbXBvcnQgc29saWRTdmcgZnJvbSBcInZpdGUtcGx1Z2luLXNvbGlkLXN2Z1wiO1xyXG5jb25zdCBwd2FPcHRpb25zOiBQYXJ0aWFsPFZpdGVQV0FPcHRpb25zPiA9IHtcclxuICBtb2RlOlxyXG4gICAgcHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwiZGV2ZWxvcG1lbnRcIlxyXG4gICAgICA/IFwiZGV2ZWxvcG1lbnRcIlxyXG4gICAgICA6IFwicHJvZHVjdGlvblwiLFxyXG4gIHJlZ2lzdGVyVHlwZTogXCJhdXRvVXBkYXRlXCIsXHJcbiAgc3JjRGlyOiBcInNyY1wiLFxyXG4gIGZpbGVuYW1lOiBcInN3LnRzXCIsXHJcbiAgaW5qZWN0UmVnaXN0ZXI6IFwiYXV0b1wiLFxyXG4gIHN0cmF0ZWdpZXM6IFwiaW5qZWN0TWFuaWZlc3RcIixcclxuICBtYW5pZmVzdDoge1xyXG4gICAgbmFtZTogXCJXZWJsaW5rXCIsXHJcbiAgICBzaG9ydF9uYW1lOiBcIldlYmxpbmtcIixcclxuICAgIHRoZW1lX2NvbG9yOiBcIiNmZmZmZmZcIixcclxuICAgIHN0YXJ0X3VybDogXCIvXCIsXHJcbiAgICBkaXNwbGF5OiBcInN0YW5kYWxvbmVcIixcclxuICAgIGljb25zOiBbXHJcbiAgICAgIHtcclxuICAgICAgICBzcmM6IFwicHdhLTY0eDY0LnBuZ1wiLFxyXG4gICAgICAgIHNpemVzOiBcIjY0eDY0XCIsXHJcbiAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIHNyYzogXCJwd2EtMTkyeDE5Mi5wbmdcIixcclxuICAgICAgICBzaXplczogXCIxOTJ4MTkyXCIsXHJcbiAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIHNyYzogXCJwd2EtNTEyeDUxMi5wbmdcIixcclxuICAgICAgICBzaXplczogXCI1MTJ4NTEyXCIsXHJcbiAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIHNyYzogXCJtYXNrYWJsZS1pY29uLTUxMng1MTIucG5nXCIsXHJcbiAgICAgICAgc2l6ZXM6IFwiNTEyeDUxMlwiLFxyXG4gICAgICAgIHR5cGU6IFwiaW1hZ2UvcG5nXCIsXHJcbiAgICAgICAgcHVycG9zZTogXCJtYXNrYWJsZVwiLFxyXG4gICAgICB9LFxyXG4gICAgXSxcclxuICB9LFxyXG4gIGJhc2U6IFwiL1wiLFxyXG4gIHdvcmtib3g6IHt9LFxyXG4gIGluamVjdE1hbmlmZXN0OiB7IHN3U3JjOiBcInNyYy9zdy50c1wiIH0sXHJcbiAgZGV2T3B0aW9uczoge1xyXG4gICAgZW5hYmxlZDogZmFsc2UsXHJcbiAgICAvKiB3aGVuIHVzaW5nIGdlbmVyYXRlU1cgdGhlIFBXQSBwbHVnaW4gd2lsbCBzd2l0Y2ggdG8gY2xhc3NpYyAqL1xyXG4gICAgdHlwZTogXCJtb2R1bGVcIixcclxuICAgIG5hdmlnYXRlRmFsbGJhY2s6IFwiaW5kZXguaHRtbFwiLFxyXG4gIH0sXHJcbn07XHJcblxyXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xyXG4gIHJlc29sdmU6IHtcclxuICAgIGFsaWFzOiB7XHJcbiAgICAgIFwiQFwiOiBcIi9zcmNcIixcclxuICAgIH0sXHJcbiAgfSxcclxuICBidWlsZDoge1xyXG4gICAgcm9sbHVwT3B0aW9uczoge1xyXG4gICAgICB0cmVlc2hha2U6IHRydWUsIC8vIFx1Nzg2RVx1NEZERFx1NTQyRlx1NzUyOHRyZWUtc2hha2luZ1xyXG4gICAgfSxcclxuICB9LFxyXG4gIC8vIG9wdGltaXplRGVwczoge1xyXG4gIC8vICAgZXhjbHVkZTogW1wiQG1hcGJveFwiXSxcclxuICAvLyB9LFxyXG5cclxuICBwbHVnaW5zOiBbXHJcbiAgICBzb2xpZFBsdWdpbigpLFxyXG4gICAgc29saWRTdmcoe1xyXG4gICAgICBzdmdvOiB7XHJcbiAgICAgICAgZW5hYmxlZDogdHJ1ZSwgLy8gb3B0aW9uYWwsIGJ5IGRlZmF1bHQgaXMgdHJ1ZVxyXG4gICAgICAgIHN2Z29Db25maWc6IHtcclxuICAgICAgICAgIHBsdWdpbnM6IFtcInByZXNldC1kZWZhdWx0XCIsIFwicmVtb3ZlRGltZW5zaW9uc1wiXSxcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgfSksXHJcbiAgICBWaXRlUFdBKHB3YU9wdGlvbnMpLFxyXG4gIF0sXHJcbiAgZXNidWlsZDoge30sXHJcbn0pO1xyXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQXNSLFNBQVMsb0JBQW9CO0FBQ25ULFNBQVMsZUFBZTtBQUN4QixPQUFPLGlCQUFpQjtBQUV4QixPQUFPLGNBQWM7QUFDckIsSUFBTSxhQUFzQztBQUFBLEVBQzFDLE1BQ0UsUUFBUSxJQUFJLGFBQWEsZ0JBQ3JCLGdCQUNBO0FBQUEsRUFDTixjQUFjO0FBQUEsRUFDZCxRQUFRO0FBQUEsRUFDUixVQUFVO0FBQUEsRUFDVixnQkFBZ0I7QUFBQSxFQUNoQixZQUFZO0FBQUEsRUFDWixVQUFVO0FBQUEsSUFDUixNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsSUFDWixhQUFhO0FBQUEsSUFDYixXQUFXO0FBQUEsSUFDWCxTQUFTO0FBQUEsSUFDVCxPQUFPO0FBQUEsTUFDTDtBQUFBLFFBQ0UsS0FBSztBQUFBLFFBQ0wsT0FBTztBQUFBLFFBQ1AsTUFBTTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsUUFDRSxLQUFLO0FBQUEsUUFDTCxPQUFPO0FBQUEsUUFDUCxNQUFNO0FBQUEsTUFDUjtBQUFBLE1BQ0E7QUFBQSxRQUNFLEtBQUs7QUFBQSxRQUNMLE9BQU87QUFBQSxRQUNQLE1BQU07QUFBQSxNQUNSO0FBQUEsTUFDQTtBQUFBLFFBQ0UsS0FBSztBQUFBLFFBQ0wsT0FBTztBQUFBLFFBQ1AsTUFBTTtBQUFBLFFBQ04sU0FBUztBQUFBLE1BQ1g7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTTtBQUFBLEVBQ04sU0FBUyxDQUFDO0FBQUEsRUFDVixnQkFBZ0IsRUFBRSxPQUFPLFlBQVk7QUFBQSxFQUNyQyxZQUFZO0FBQUEsSUFDVixTQUFTO0FBQUE7QUFBQSxJQUVULE1BQU07QUFBQSxJQUNOLGtCQUFrQjtBQUFBLEVBQ3BCO0FBQ0Y7QUFFQSxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCxLQUFLO0FBQUEsSUFDUDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNMLGVBQWU7QUFBQSxNQUNiLFdBQVc7QUFBQTtBQUFBLElBQ2I7QUFBQSxFQUNGO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFLQSxTQUFTO0FBQUEsSUFDUCxZQUFZO0FBQUEsSUFDWixTQUFTO0FBQUEsTUFDUCxNQUFNO0FBQUEsUUFDSixTQUFTO0FBQUE7QUFBQSxRQUNULFlBQVk7QUFBQSxVQUNWLFNBQVMsQ0FBQyxrQkFBa0Isa0JBQWtCO0FBQUEsUUFDaEQ7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBQUEsSUFDRCxRQUFRLFVBQVU7QUFBQSxFQUNwQjtBQUFBLEVBQ0EsU0FBUyxDQUFDO0FBQ1osQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
