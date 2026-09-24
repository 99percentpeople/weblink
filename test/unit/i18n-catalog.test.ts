import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "@/assets/i18n/en-us.json";
import cn from "@/assets/i18n/zh-cn.json";
import tw from "@/assets/i18n/zh-tw.json";

function flatten(
  value: object,
  prefix = "",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[prefix + key, value]]
        : Object.entries(
            flatten(value, prefix + key + "."),
          ),
    ),
  );
}
const catalogs = {
  "en-us": flatten(en),
  "zh-cn": flatten(cn),
  "zh-tw": flatten(tw),
};
const keys = Object.keys(catalogs["en-us"]).sort();
const placeholders = (value: string) =>
  [...value.matchAll(/\{\{(\w+)\}\}/g)]
    .map((match) => match[1])
    .sort();

describe("translation catalogs", () => {
  it.each(Object.entries(catalogs))(
    "keeps keys and placeholders consistent in %s",
    (_locale, catalog) => {
      expect(Object.keys(catalog).sort()).toEqual(keys);
      for (const key of keys) {
        expect(catalog[key].trim(), key).not.toBe("");
        expect(placeholders(catalog[key]), key).toEqual(
          placeholders(catalogs["en-us"][key]),
        );
      }
    },
  );
  it("defines literal translation references, including keys passed through helpers", () => {
    const root = resolve("src");
    const namespaces = new Set(
      keys.map((key) => key.split(".")[0]),
    );
    const missing = new Set<string>();
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, {
        withFileTypes: true,
      })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(path)) continue;
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const visit = (node: ts.Node) => {
          if (ts.isStringLiteralLike(node)) {
            const key = node.text;
            const direct =
              ts.isCallExpression(node.parent) &&
              node.parent.expression.getText(source) ===
                "t" &&
              node.parent.arguments[0] === node;
            if (
              (direct ||
                namespaces.has(key.split(".")[0])) &&
              key.includes(".") &&
              !key.endsWith(".") &&
              !(key in catalogs["en-us"])
            )
              missing.add(
                `${path.slice(root.length)}: ${key}`,
              );
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    };
    walk(root);
    expect([...missing]).toEqual([]);
  });
});
