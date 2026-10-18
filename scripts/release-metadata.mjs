import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateReleaseMetadata({
  tag,
  version,
  changelog,
}) {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      tag ?? "",
    ) ||
    tag !== `v${version}`
  ) {
    throw new Error(
      "The release tag must match the stable version in apps/web/package.json",
    );
  }

  const section = changelog
    .split(/^## /m)
    .find((entry) => entry.startsWith(`[${version}] - `));
  const [heading, ...lines] = section?.split(/\r?\n/) ?? [];
  const date = heading?.slice(`[${version}] - `.length);
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date
  ) {
    throw new Error(
      `Add dated release notes for ${tag} to CHANGELOG.md (YYYY-MM-DD, not Unreleased)`,
    );
  }
  const changes = lines.join("\n").trim();
  if (!changes) {
    throw new Error(`Missing changelog content for ${tag}`);
  }
  return { version, date, changes };
}

export async function loadReleaseMetadata(tag) {
  const root = new URL("../", import.meta.url);
  const [metadata, changelog] = await Promise.all([
    readFile(
      new URL("apps/web/package.json", root),
      "utf8",
    ),
    readFile(new URL("CHANGELOG.md", root), "utf8"),
  ]);
  return validateReleaseMetadata({
    tag,
    version: JSON.parse(metadata).version,
    changelog,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  const tag = process.argv[2];
  const release = await loadReleaseMetadata(tag);
  console.log(`Verified ${tag} (${release.date})`);
}
