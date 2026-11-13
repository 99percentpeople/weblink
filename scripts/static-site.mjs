import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const manifestName = "deployment.json";

export async function contentHash(directory) {
  await access(join(directory, "index.html"));
  const hash = createHash("sha256");
  async function visit(relative = "") {
    const entries = await readdir(
      join(directory, relative),
      { withFileTypes: true },
    );
    entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = relative
        ? relative + "/" + entry.name
        : entry.name;
      if (path === manifestName) continue;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(directory, path));
        const digest = createHash("sha256")
          .update(bytes)
          .digest("hex");
        hash.update(JSON.stringify([path, digest]) + "\n");
      } else {
        throw new Error("Unsupported build entry: " + path);
      }
    }
  }
  await visit();
  return hash.digest("hex");
}

export async function prepareSite(
  site,
  directory,
  commit = process.env.GITHUB_SHA ?? null,
) {
  const manifest = {
    site,
    hash: await contentHash(directory),
    commit,
  };
  await writeFile(
    join(directory, manifestName),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

async function publishedManifest(baseUrl, fetchImpl) {
  const url = new URL(manifestName, baseUrl);
  url.searchParams.set("check", Date.now().toString());
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      "Cannot check published site: HTTP " +
        response.status,
    );
  }
  // Older sites may serve their HTML fallback for an unknown JSON path.
  if (
    !response.headers
      .get("content-type")
      ?.includes("application/json")
  ) {
    return null;
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function matches(expected, actual) {
  return (
    actual?.site === expected.site &&
    actual?.hash === expected.hash
  );
}

export async function needsDeployment(
  expected,
  baseUrl,
  { fetchImpl = fetch, force = false } = {},
) {
  if (force) return true;
  return !matches(
    expected,
    await publishedManifest(baseUrl, fetchImpl),
  );
}

export async function verifyDeployment(
  expected,
  baseUrl,
  {
    fetchImpl = fetch,
    attempts = 12,
    delayMs = 5000,
    wait = sleep,
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (
        matches(
          expected,
          await publishedManifest(baseUrl, fetchImpl),
        )
      ) {
        return;
      }
    } catch {
      // The deployment may still be propagating; verification stays bounded.
    }
    if (attempt < attempts) await wait(delayMs);
  }
  throw new Error(
    "Published " +
      expected.site +
      " content does not match " +
      expected.hash,
  );
}

async function main() {
  const [command, site, directory, baseUrl] =
    process.argv.slice(2);
  if (
    !["prepare", "check", "verify"].includes(command) ||
    !["www", "docs"].includes(site) ||
    !directory ||
    (command !== "prepare" && !baseUrl)
  ) {
    throw new Error(
      "Usage: static-site.mjs prepare|check|verify www|docs <directory> [published-base-url]",
    );
  }
  if (command === "prepare") {
    const manifest = await prepareSite(site, directory);
    console.log(site + " content: " + manifest.hash);
    return;
  }
  const expected = JSON.parse(
    await readFile(join(directory, manifestName), "utf8"),
  );
  if (
    expected.site !== site ||
    !/^[a-f0-9]{64}$/.test(expected.hash)
  ) {
    throw new Error("Invalid local deployment manifest");
  }
  if (command === "check") {
    const changed = await needsDeployment(
      expected,
      baseUrl,
      {
        force: process.env.FORCE_DEPLOY === "true",
      },
    );
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        "changed=" + changed + "\n",
      );
    }
    console.log(
      changed
        ? site + " needs deployment"
        : site + " is unchanged; skipping deployment",
    );
  } else {
    await verifyDeployment(expected, baseUrl);
    console.log("Verified " + site + ": " + expected.hash);
  }
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
