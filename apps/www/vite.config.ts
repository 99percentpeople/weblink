import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL(".", import.meta.url)),
    "VITE_",
  );
  const docsUrl = new URL(
    env.VITE_DOCS_URL?.trim() ||
      (mode === "development"
        ? "http://localhost:5175/"
        : "https://docs.webl.ink/"),
  );
  if (
    !["http:", "https:"].includes(docsUrl.protocol) ||
    docsUrl.search ||
    docsUrl.hash
  ) {
    throw new Error(
      "VITE_DOCS_URL must be an HTTP(S) base URL without a query or fragment.",
    );
  }
  docsUrl.pathname = docsUrl.pathname.replace(/\/?$/, "/");

  return {
    // The same static build can be hosted on a domain or in a subdirectory.
    base: "./",
    plugins: [solid()],
    // Vite applies the same value to HTML placeholders and client-side links.
    define: {
      "import.meta.env.VITE_DOCS_URL": JSON.stringify(
        docsUrl.href,
      ),
    },
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
  };
});
