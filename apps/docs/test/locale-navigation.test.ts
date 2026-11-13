import { expect, test } from "bun:test";
import { localeNavigationTarget } from "../.vitepress/theme/locale-navigation";

test("locale switches keep the article without inheriting translated headings", () => {
  expect(
    localeNavigationTarget(
      "/guide/files.html#文件与协作",
      "https://docs.example.com/zh/guide/files.html#文件与协作",
      "/",
    ),
  ).toBe("https://docs.example.com/guide/files.html");
});

test("language navigation also works when deployed under a base path", () => {
  expect(
    localeNavigationTarget(
      "/help/zh/guide/automation.html#tools",
      "https://docs.example.com/help/guide/automation.html#tools",
      "/help/",
    ),
  ).toBe(
    "https://docs.example.com/help/zh/guide/automation.html",
  );
});

test("ordinary anchors and explicit cross-language section links are preserved", () => {
  const current =
    "https://docs.example.com/guide/files.html#storage";
  for (const target of [
    "#storage",
    "/guide/files.html#storage",
    "/zh/guide/files.html#shared-files",
    "/zh/guide/storage.html#storage",
    "https://other.example.com/zh/guide/files.html#storage",
  ])
    expect(
      localeNavigationTarget(target, current, "/"),
    ).toBe(target);
});
