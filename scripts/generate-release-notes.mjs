import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

const [tag, outputPath] = process.argv.slice(2);
if (
  !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
    tag ?? "",
  ) ||
  !outputPath
) {
  throw new Error(
    "Usage: bun scripts/generate-release-notes.mjs vX.Y.Z <output.md>",
  );
}

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(
    new URL("apps/web/package.json", root),
    "utf8",
  ),
);
if (tag !== `v${version}`) {
  throw new Error(
    "The release tag must match apps/web/package.json",
  );
}

const changelog = await readFile(
  new URL("CHANGELOG.md", root),
  "utf8",
);
const section = changelog
  .split(/^## /m)
  .find((entry) => entry.startsWith(`[${version}] - `));
const [, ...changeLines] = section?.split(/\r?\n/) ?? [];
const changes = changeLines.join("\n").trim();
if (!changes) {
  throw new Error(`Missing changelog content for ${tag}`);
}

const repository =
  process.env.GITHUB_REPOSITORY ??
  "99percentpeople/weblink";
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error("Invalid GITHUB_REPOSITORY");
}
// Pin downloads to this release so older notes retain their own binaries.
const download = `https://github.com/${repository}/releases/download/${tag}`;
const notes = `## Downloads / 下载

Windows 10 22H2 / Windows 11 · x64

| Package / 版本 | Download / 下载 | Usage / 使用方式 |
| --- | --- | --- |
| Installer / 安装版 | [Weblink-windows-x64-setup.exe](${download}/Weblink-windows-x64-setup.exe) | Installs WebView2 when needed; supports signed, user-confirmed in-app updates. / 按需安装 WebView2，支持确认后在应用内安装签名更新。 |
| Portable / 免安装版 | [Weblink-windows-x64-portable.zip](${download}/Weblink-windows-x64-portable.zip) | Extract both weblink-desktop.exe and weblink-portable; requires WebView2 120+. Replace manually to update. / 解压并保留程序及 weblink-portable 标记，需 WebView2 120 或更新版本；更新时手动替换。 |

## Changes / 更新内容

${changes}
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, notes, "utf8");
console.log(`Generated ${outputPath} for ${tag}`);
