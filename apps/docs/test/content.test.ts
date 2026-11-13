import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import {
  pages,
  pageLink,
  sourceExcludes,
} from "../.vitepress/catalog";
import {
  sourceForPage,
  tokenize,
} from "../.vitepress/content";
import { navigation } from "../.vitepress/navigation";

const docs = fileURLToPath(
  new URL("../../../docs", import.meta.url),
);
const normalize = (path: string) =>
  path.replaceAll("\\", "/");
const read = (path: string) =>
  readFileSync(resolve(docs, path), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const anchors = (text: string) =>
  Array.from(
    text.matchAll(/^#{2,6} .+ \{#([^}]+)\}$/gm),
    (match) => match[1],
  );
const examples = (text: string) =>
  Array.from(
    text.matchAll(
      /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm,
    ),
    (match) => match[0].trim(),
  );
const sources = pages.flatMap((page) => [
  page.route + ".md",
  "zh/" + page.route + ".md",
]);
const sourceSet = new Set(sources);

interface NavigationItem {
  link?: string;
  items?: NavigationItem[];
}
const links = (items: NavigationItem[]): string[] =>
  items.flatMap((item) => [
    ...(item.link ? [item.link] : []),
    ...links(item.items ?? []),
  ]);

describe("user documentation", () => {
  test("the build publishes exactly the bilingual guides, architecture, and deployment pages", () => {
    const excluded = new Set(
      sourceExcludes.flatMap((pattern) =>
        Array.from(
          new Glob(pattern).scanSync({
            cwd: docs,
            onlyFiles: true,
          }),
          normalize,
        ),
      ),
    );
    const published = Array.from(
      new Glob("**/*.md").scanSync({
        cwd: docs,
        onlyFiles: true,
      }),
      normalize,
    ).filter((file) => !excluded.has(file));
    expect(published.sort()).toEqual([...sources].sort());
    expect(sourceSet.size).toBe(sources.length);
    // Keep engineering notes in the repository while excluding them from publication.
    for (const file of [
      "development/workspace.md",
      "reference/p2p-protocol.md",
      "en/development/testing.md",
      "en/reference/automation.md",
      "AUTOMATION.md",
    ]) {
      expect(read(file).length).toBeGreaterThan(0);
      expect(excluded.has(file)).toBe(true);
    }
  });

  test("translations preserve section targets and runnable examples", () => {
    for (const page of pages) {
      const zh = read("zh/" + page.route + ".md");
      const en = read(page.route + ".md");
      expect(zh).toMatch(/[\p{Script=Han}]/u);
      expect(anchors(zh)).toEqual(anchors(en));
      expect(examples(zh)).toEqual(examples(en));
      expect(new Set(anchors(en)).size).toBe(
        anchors(en).length,
      );
      expect(zh).not.toContain("<!--@include:");
      expect(en).not.toContain("<!--@include:");
    }
  });

  test("user guides only link to published local articles and existing sections", () => {
    for (const file of sources) {
      const content = read(file).replace(
        /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm,
        "",
      );
      for (const match of content.matchAll(
        /\[[^\]]*\]\(([^\s)]+)\)/g,
      )) {
        const href = match[1];
        if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;
        const [target, fragment] = href.split("#");
        if (target && !target.endsWith(".md")) continue;
        const destination = !target
          ? resolve(docs, file)
          : target.startsWith("/")
            ? resolve(docs, "." + target)
            : resolve(dirname(resolve(docs, file)), target);
        const source = normalize(
          relative(docs, destination),
        );
        expect(
          sourceSet.has(source),
          file + " links to " + href,
        ).toBe(true);
        if (fragment)
          expect(
            anchors(read(source)),
            file + " links to " + href,
          ).toContain(decodeURIComponent(fragment));
      }
    }
  });

  test("both sidebars expose every public article without internal routes", () => {
    for (const locale of ["zh", "en"] as const) {
      const config = navigation(locale);
      if (!Array.isArray(config.sidebar))
        throw new Error("Expected a shared sidebar");
      expect(links(config.sidebar).sort()).toEqual(
        pages
          .map((page) => pageLink(page.route, locale))
          .sort(),
      );
      expect(JSON.stringify(config)).not.toMatch(
        /\/(?:(?:en|zh)\/)?(?:development|reference)\//,
      );
    }
  });

  test("edit links and locale roots target the public sources", () => {
    expect(sourceForPage("guide/desktop.md")).toBe(
      "docs/guide/desktop.md",
    );
    expect(sourceForPage("zh/guide/automation.md")).toBe(
      "docs/zh/guide/automation.md",
    );
    expect(pageLink("index", "zh")).toBe("/zh/");
    expect(pageLink("index", "en")).toBe("/");
    expect(pageLink("guide/files", "en")).toBe(
      "/guide/files.html",
    );
    expect(pageLink("guide/files", "zh")).toBe(
      "/zh/guide/files.html",
    );
  });
});

describe("multilingual search", () => {
  test("Chinese prose is split into searchable words", () => {
    const terms = tokenize("远程桌面支持文件传输");
    expect(terms).toContain("文件");
    expect(terms).toContain("传输");
    expect(terms.length).toBeGreaterThan(2);
  });

  test("browser serialization preserves mixed-language tokenization", () => {
    const inBrowser = new Function(
      "return (" + tokenize.toString() + ")",
    )() as typeof tokenize;
    const query = "WebRTC 文件传输 １２３";
    expect(inBrowser(query)).toEqual(tokenize(query));
    expect(tokenize(query)).toContain("webrtc");
    expect(tokenize(query)).toContain("123");
  });
});
