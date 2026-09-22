import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [solid()],
  test: {
    include: [
      "test/unit/**/*.test.{ts,tsx}",
      "test/integration/**/*.test.{ts,tsx}",
    ],
  },
  resolve: {
    conditions: ["development", "browser"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
