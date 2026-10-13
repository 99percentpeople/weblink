import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  // The same static build can be hosted on a domain or in a subdirectory.
  base: "./",
  plugins: [solid()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
});
