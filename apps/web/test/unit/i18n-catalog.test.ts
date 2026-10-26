import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "@/assets/i18n/en-us.json";
import { localeOptionsMap as languages } from "@weblink/locale";

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
const catalogs = Object.fromEntries(
  Object.keys(languages).map((locale) => [
    locale,
    flatten(
      JSON.parse(
        readFileSync(
          resolve(`src/assets/i18n/${locale}.json`),
          "utf8",
        ),
      ),
    ),
  ]),
);
const keys = Object.keys(catalogs["en-us"]).sort();
const placeholders = (value: string) =>
  [...value.matchAll(/\{\{(\w+)\}\}/g)]
    .map((match) => match[1])
    .sort();

// Reviewed shared spellings and technical terms. New English copies in a
// non-English catalog need an explicit review instead of passing key parity.
const sharedTerms = ["RTT", "{{page}} / {{count}}"];
const unchangedTerms: Record<string, readonly string[]> = {
  "de-de": [
    "Pause",
    "Status",
    "Hardware",
    "Software",
    "Mono",
    "Trackpad",
    "Touch",
    "Gamepad",
    "Touchscreen",
    "Clients",
    "Chat",
    "Browser",
    "Version",
    "System",
    "Name",
    "Avatar",
    "Online",
    "Offline",
    "Layout",
    "Info",
    "Videos",
    "Audio",
    "Details",
    "Port",
  ],
  "es-es": [
    "Diagonal",
    "Hardware",
    "Software",
    "Mono",
    "Chat",
    "Avatar",
    "Audio",
  ],
  "fr-fr": [
    "Pause",
    "Maintenance",
    "Mono",
    "Clients",
    "Version",
    "Avatar",
    "Session",
    "Client {{name}}",
    "Conversations",
    "Microphone",
    "Microphone {{count}}",
    "Application",
    "Notifications",
    "Images",
    "Audio",
    "Documents",
    "Port",
  ],
};

describe("translation catalogs", () => {
  it("registers every language catalog", () => {
    expect(
      readdirSync(resolve("src/assets/i18n"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .sort(),
    ).toEqual(Object.keys(languages).sort());
    expect(catalogs["en-us"]).toEqual(flatten(en));
  });
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
  it.each(
    Object.entries(catalogs).filter(
      ([locale]) => locale !== "en-us",
    ),
  )(
    "does not leave unreviewed English text in %s",
    (locale, catalog) => {
      const allowed = new Set([
        ...sharedTerms,
        ...(unchangedTerms[locale] ?? []),
      ]);
      const untranslated = Object.entries(catalog)
        .filter(
          ([key, value]) =>
            value === catalogs["en-us"][key] &&
            /[a-z]/i.test(value) &&
            !allowed.has(value),
        )
        .map(([key]) => key);
      expect(untranslated).toEqual([]);
    },
  );
  it.each(Object.entries(catalogs))(
    "keeps shared labels consistent across surfaces in %s",
    (_locale, catalog) => {
      for (const [alias, common] of [
        [
          "setting.permissions.allow_permanently",
          "common.action.always_allow",
        ],
        [
          "app_menu.settings_automation",
          "automation.title",
        ],
        ["video.loading_state.loading", "common.loading"],
        [
          "common.forward_dialog.no_results_found",
          "common.no_results_found",
        ],
      ]) {
        expect(catalog[alias], alias).toBe(catalog[common]);
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
