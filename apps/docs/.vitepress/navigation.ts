import type { DefaultTheme } from "vitepress";
import {
  pageLink,
  pages,
  type DocPage,
  type Locale,
} from "./catalog";

export function navigation(
  locale: Locale,
): DefaultTheme.Config {
  const zh = locale === "zh";
  const start = pageLink("index", locale);
  const link = (route: string) => pageLink(route, locale);
  const sectionItems = (section: DocPage["section"]) =>
    pages
      .filter((page) => page.section === section)
      .map((page) => ({
        text: page[locale],
        link: link(page.route),
      }));

  return {
    nav: [
      {
        text: zh ? "开始使用" : "Get started",
        link: start,
        activeMatch: "^/(?:zh/)?(?:$|guide/(?!faq))",
      },
      {
        text: zh ? "设计架构" : "Architecture",
        link: link("architecture/overview"),
        activeMatch: "/architecture/",
      },
      {
        text: zh ? "自行部署" : "Self-hosting",
        link: link("deployment/overview"),
        activeMatch: "/deployment/",
      },
      {
        text: zh ? "常见问题" : "Troubleshooting",
        link: link("guide/faq"),
        activeMatch: "/guide/faq",
      },
      {
        text: zh ? "打开 Weblink" : "Open Weblink",
        link: "https://webl.ink",
      },
    ],
    sidebar: [
      {
        text: zh ? "开始使用" : "Get started",
        items: sectionItems("guide"),
      },
      {
        text: zh ? "设计架构" : "Architecture",
        items: sectionItems("architecture"),
      },
      {
        text: zh ? "自行部署" : "Self-hosting",
        items: sectionItems("deployment"),
      },
    ],
    outline: {
      level: [2, 3],
      label: zh ? "本页目录" : "On this page",
    },
    docFooter: {
      prev: zh ? "上一篇" : "Previous page",
      next: zh ? "下一篇" : "Next page",
    },
    editLink: {
      text: zh
        ? "在 GitHub 上编辑此页"
        : "Edit this page on GitHub",
      pattern:
        "https://github.com/99percentpeople/weblink/edit/public/:path",
    },
    lastUpdated: {
      text: zh ? "最后更新" : "Last updated",
      formatOptions: { dateStyle: "medium" },
    },
    langMenuLabel: zh ? "切换语言" : "Change language",
    sidebarMenuLabel: zh ? "文档导航" : "Menu",
    returnToTopLabel: zh ? "返回顶部" : "Return to top",
    darkModeSwitchLabel: zh ? "外观" : "Appearance",
    lightModeSwitchTitle: zh
      ? "切换到浅色模式"
      : "Switch to light theme",
    darkModeSwitchTitle: zh
      ? "切换到深色模式"
      : "Switch to dark theme",
    skipToContentLabel: zh
      ? "跳转到正文"
      : "Skip to content",
    notFound: {
      title: zh ? "页面未找到" : "Page not found",
      quote: zh
        ? "这篇文档可能已移动，请从首页或搜索继续查找。"
        : "This page may have moved. Try the homepage or search.",
      linkLabel: zh
        ? "返回文档首页"
        : "Go to the documentation homepage",
      linkText: zh ? "返回首页" : "Go home",
    },
    footer: {
      message: zh
        ? "以 MIT 许可证开源 · 为设备之间的连接而构建"
        : "MIT licensed · Built for connections between devices",
      copyright: "Weblink",
    },
  };
}
