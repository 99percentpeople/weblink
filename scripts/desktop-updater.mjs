import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "99percentpeople/weblink";

export function createUpdaterConfig(publicKey) {
  const pubkey = publicKey?.trim();
  if (!pubkey)
    throw new Error("Missing WEBLINK_UPDATER_PUBLIC_KEY");
  const decoded = Buffer.from(pubkey, "base64").toString(
    "utf8",
  );
  const lines = decoded.trim().split(/\r?\n/);
  if (
    !lines[0]?.startsWith("untrusted comment:") ||
    Buffer.from(lines[1] ?? "", "base64").length !== 42
  ) {
    throw new Error(
      "WEBLINK_UPDATER_PUBLIC_KEY must contain the Tauri .pub file contents, not its path",
    );
  }
  return {
    build: { beforeBuildCommand: "" },
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey } },
  };
}

export function createUpdateManifest({
  tag,
  version,
  signature,
  notes,
  publishedAt,
}) {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      tag,
    ) ||
    tag !== `v${version}`
  ) {
    throw new Error(
      "Stable release tag must match apps/web/package.json",
    );
  }
  if (!signature?.trim())
    throw new Error("Missing installer signature");
  if (!notes?.trim())
    throw new Error("Missing release notes");
  if (!Number.isFinite(Date.parse(publishedAt)))
    throw new Error("Invalid release date");
  return {
    version,
    notes: notes.trim(),
    pub_date: new Date(publishedAt).toISOString(),
    platforms: {
      "windows-x86_64": {
        url: `https://github.com/${repository}/releases/download/${tag}/Weblink-windows-x64-setup.exe`,
        signature: signature.trim(),
      },
    },
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let output;
  let data;
  if (command === "config" && args.length === 1) {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
      throw new Error("Missing TAURI_SIGNING_PRIVATE_KEY");
    }
    [output] = args;
    data = createUpdaterConfig(
      process.env.WEBLINK_UPDATER_PUBLIC_KEY,
    );
  } else if (command === "manifest" && args.length === 4) {
    const [tag, signatureFile, notesFile, outputFile] =
      args;
    output = outputFile;
    const { version } = JSON.parse(
      await readFile(
        new URL(
          "../apps/web/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    data = createUpdateManifest({
      tag,
      version,
      signature: await readFile(signatureFile, "utf8"),
      notes: await readFile(notesFile, "utf8"),
      publishedAt: new Date().toISOString(),
    });
  } else {
    throw new Error(
      "Usage: bun scripts/desktop-updater.mjs config <output.json> | manifest <vX.Y.Z> <installer.sig> <notes.md> <latest.json>",
    );
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(data, null, 2) + "\n",
  );
  console.log(`Generated ${output}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  await main();
}
