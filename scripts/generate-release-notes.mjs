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
const notes = `## Downloads

Windows 10 22H2 / Windows 11 · x64

| Package | Download | Usage |
| --- | --- | --- |
| Installer | [Weblink-windows-x64-setup.exe](${download}/Weblink-windows-x64-setup.exe) | Installs WebView2 when needed; supports signed, user-confirmed in-app updates. |
| Portable | [Weblink-windows-x64-portable.zip](${download}/Weblink-windows-x64-portable.zip) | Extract both weblink-desktop.exe and weblink-portable; requires WebView2 120+. Replace manually to update. |

The empty \`weblink-portable\` file identifies the portable edition for update checks. Keep it beside \`weblink-desktop.exe\`.

## Changes

${changes}
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, notes, "utf8");
console.log(`Generated ${outputPath} for ${tag}`);
