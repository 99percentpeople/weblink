import { execFileSync } from "node:child_process";
import type { Plugin } from "vite";

export interface BuildInfo {
  version: string;
  channel: "stable" | "dev";
  commit: string | null;
  builtAt: string;
}

export function createBuildInfo(
  version: string,
  mode: string,
  commit: string | undefined,
  builtAt = Date.now(),
): BuildInfo {
  const hash = /^[a-f\d]{7,40}$/i.test(commit ?? "")
    ? commit!.toLowerCase()
    : null;
  const channel = mode === "dev" ? "dev" : "stable";
  return {
    version:
      channel === "dev"
        ? `${version}-dev.${hash?.slice(0, 7) ?? "local"}`
        : version,
    channel,
    commit: hash,
    builtAt: new Date(builtAt).toISOString(),
  };
}

export function getBuildCommit(): string | undefined {
  const commit =
    process.env.GITHUB_SHA ??
    process.env.CF_PAGES_COMMIT_SHA;
  if (commit) return commit;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Source archives and local builds need not have a .git directory.
    return undefined;
  }
}

export function buildInfoPlugin(info: BuildInfo): Plugin {
  return {
    name: "weblink-build-info",
    apply: "build",
    transformIndexHtml(html) {
      if (info.channel !== "dev") return html;
      return {
        html: html.replace(
          /<title>[^<]*<\/title>/,
          "<title>Weblink Dev</title>",
        ),
        tags: [
          {
            tag: "meta",
            attrs: {
              name: "robots",
              content: "noindex, nofollow, noarchive",
            },
            injectTo: "head",
          },
        ],
      };
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify(info, null, 2) + "\n",
      });
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source:
          (info.channel === "dev"
            ? "/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n\n"
            : "") +
          "/version.json\n  Cache-Control: no-store\n",
      });
      if (info.channel === "dev") {
        this.emitFile({
          type: "asset",
          fileName: "robots.txt",
          source: "User-agent: *\nDisallow: /\n",
        });
      }
    },
  };
}
