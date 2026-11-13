import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig } from "vitepress";
import { sourceExcludes, repository } from "./catalog";
import { sourceForPage, tokenize } from "./content";
import { navigation } from "./navigation";

const base = process.env.DOCS_BASE ?? "/";
const require = createRequire(import.meta.url);
if (!base.startsWith("/") || !base.endsWith("/")) {
  throw new Error(
    "DOCS_BASE must start and end with /, for example /docs/.",
  );
}

export default defineConfig({
  title: "Weblink Docs",
  description:
    "Weblink usage, architecture, configuration, self-hosting and troubleshooting.",
  lang: "en",
  base,
  srcDir: "../../docs",
  srcExclude: sourceExcludes,
  outDir: "./dist",
  cacheDir: "./.vitepress/cache",
  // Explicit .html links work on plain static hosts without rewrite rules.
  cleanUrls: false,
  lastUpdated: true,
  // Stable local-search document IDs keep unchanged build hashes identical.
  buildConcurrency: 1,
  useWebFonts: false,
  transformPageData(page) {
    page.filePath = sourceForPage(page.relativePath);
  },
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: base + "favicon.svg",
      },
    ],
    ["meta", { name: "theme-color", content: "#315fa8" }],
  ],
  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: navigation("en"),
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      description:
        "Weblink 功能使用、设计架构、配置、自部署与常见问题。",
      themeConfig: navigation("zh"),
    },
  },
  themeConfig: {
    logo: {
      light: "/logo.svg",
      dark: "/logo-dark.svg",
      alt: "",
    },
    siteTitle: "Weblink",
    socialLinks: [{ icon: "github", link: repository }],
    search: {
      provider: "local",
      options: {
        miniSearch: { options: { tokenize } },
        locales: {
          zh: {
            translations: {
              button: {
                buttonText: "搜索文档",
                buttonAriaLabel: "搜索文档",
              },
              modal: {
                noResultsText: "没有找到相关文档",
                resetButtonTitle: "清空搜索",
                backButtonTitle: "关闭搜索",
                displayDetails: "显示详细结果",
                footer: {
                  selectText: "打开",
                  navigateText: "切换",
                  closeText: "关闭",
                },
              },
            },
          },
        },
      },
    },
  },
  markdown: {
    languageAlias: { env: "dotenv" },
    config(md) {
      md.renderer.rules.table_open = (
        tokens,
        index,
        options,
        _env,
        renderer,
      ) =>
        '<div class="docs-table">' +
        renderer.renderToken(tokens, index, options);
      md.renderer.rules.table_close = (
        tokens,
        index,
        options,
        _env,
        renderer,
      ) =>
        renderer.renderToken(tokens, index, options) +
        "</div>\n";
    },
  },
  vite: {
    publicDir: fileURLToPath(
      new URL("../public", import.meta.url),
    ),
    // Markdown lives outside this workspace. Resolve Vue here instead of
    // expecting it to be hoisted beside the shared documentation directory.
    resolve: {
      alias: [
        {
          find: /^vue$/,
          replacement:
            require.resolve("vue/dist/vue.runtime.esm-bundler.js"),
        },
        {
          find: /^vue\/server-renderer$/,
          replacement:
            require.resolve("vue/server-renderer"),
        },
      ],
    },
    server: { strictPort: true },
    preview: { strictPort: true },
  },
});
