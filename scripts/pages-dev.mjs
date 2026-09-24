import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEV_BRANCH = "dev";
export const DEV_DOMAIN = "dev.webl.ink";

/** Refuse to publish a development build through the production branch. */
export function getDevTarget(project) {
  if (
    !project ||
    typeof project.production_branch !== "string" ||
    !project.production_branch ||
    project.production_branch === DEV_BRANCH
  ) {
    throw new Error(
      "Pages production branch must exist and must not be dev",
    );
  }
  if (
    typeof project.subdomain !== "string" ||
    !/^[a-z0-9-]+\.pages\.dev$/.test(project.subdomain)
  ) {
    throw new Error(
      "Pages project has an invalid pages.dev subdomain",
    );
  }
  return `${DEV_BRANCH}.${project.subdomain}`;
}

export function createCloudflareClient(
  token,
  fetcher = fetch,
) {
  if (!token)
    throw new Error(
      "Configure CLOUDFLARE_API_TOKEN in GitHub Actions",
    );
  return async (path, method = "GET", body) => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const data = await response.json();
    if (!response.ok || !data.success) {
      const codes = (data.errors ?? [])
        .map((error) => error.code)
        .join(", ");
      // Never include request headers, deployment settings or token values.
      throw new Error(
        `Cloudflare ${method} ${path} failed: HTTP ${response.status}, codes ${codes}`,
      );
    }
    return data.result;
  };
}

export async function verifyDevDeployment(
  hostname,
  commit,
  fetcher = fetch,
  pause = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
) {
  if (!/^[a-f\d]{40}$/i.test(commit ?? ""))
    throw new Error("A full commit SHA is required");
  if (
    hostname !== DEV_DOMAIN &&
    !/^dev\.[a-z0-9-]+\.pages\.dev$/.test(hostname)
  ) {
    throw new Error(
      "Refusing to verify an unexpected development hostname",
    );
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetcher(
        `https://${hostname}/version.json?commit=${commit}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) {
        const info = await response.json();
        if (
          info.channel === "dev" &&
          info.commit === commit &&
          typeof info.version === "string" &&
          info.version.endsWith(
            `-dev.${commit.slice(0, 7)}`,
          )
        )
          return info;
      }
    } catch {
      // A freshly deployed alias or certificate may not be ready yet.
    }
    if (attempt < 11) await pause(5_000);
  }
  throw new Error(
    `${hostname} does not serve dev commit ${commit}`,
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "verify") {
    const hostname = process.argv[3];
    const info = await verifyDevDeployment(
      hostname,
      process.env.GITHUB_SHA,
    );
    console.info(
      `${hostname}: ${info.version} (${info.commit})`,
    );
    return;
  }
  if (command !== "check")
    throw new Error("Expected check or verify");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account)
    throw new Error(
      "Configure CLOUDFLARE_ACCOUNT_ID in the Preview environment",
    );
  const api = createCloudflareClient(
    process.env.CLOUDFLARE_API_TOKEN,
  );
  const projectPath = `/accounts/${encodeURIComponent(account)}/pages/projects/weblink`;
  const target = getDevTarget(await api(projectPath));
  console.info(
    `Development target: ${target}; production branch unchanged`,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `alias=${target}\n`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
