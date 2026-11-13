import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sites = {
  docs: {
    project: "weblink-docs",
    domain: "docs.webl.ink",
  },
  www: { project: "weblink-www", domain: "www.webl.ink" },
};

export async function setupPagesDomain(
  site,
  { api, accountId, log = console.log },
) {
  const target = sites[site];
  if (!target)
    throw new Error("Expected site: docs or www");
  if (!accountId) {
    const accounts = await api("/accounts?per_page=50");
    if (accounts.length !== 1) {
      throw new Error(
        "Set CLOUDFLARE_ACCOUNT_ID to select the Pages account",
      );
    }
    accountId = accounts[0].id;
  }

  const projectPath = `/accounts/${accountId}/pages/projects/${target.project}`;
  const project = await api(projectPath);
  if (project.production_branch !== "public") {
    throw new Error(
      "The Pages production branch must be public",
    );
  }
  if (!/^[a-z0-9-]+\.pages\.dev$/.test(project.subdomain)) {
    throw new Error("Unexpected Pages project hostname");
  }

  const domains = await api(projectPath + "/domains");
  let domain = domains.find(
    (entry) => entry.name === target.domain,
  );
  if (!domain) {
    domain = await api(projectPath + "/domains", {
      name: target.domain,
    });
  }
  log(`Pages domain: ${target.domain} (${domain.status})`);
  log(
    `Required DNS: CNAME ${target.domain} -> ${project.subdomain}`,
  );

  let zoneId = domain.zone_tag;
  if (!zoneId) {
    const zones = await api(
      "/zones?name=webl.ink&status=active",
    );
    if (
      zones.length !== 1 ||
      zones[0].account.id !== accountId
    ) {
      throw new Error(
        "Cannot select the webl.ink zone in the Pages account",
      );
    }
    zoneId = zones[0].id;
  }
  const recordsPath = `/zones/${zoneId}/dns_records`;
  const records = await api(
    recordsPath + "?name=" + target.domain,
  );
  if (records.length) {
    if (
      records.length !== 1 ||
      records[0].type !== "CNAME" ||
      records[0].content.replace(/\.$/, "") !==
        project.subdomain
    ) {
      throw new Error(
        "Existing DNS records differ; review them in Cloudflare before continuing",
      );
    }
    log(
      "DNS already points to the Pages project; no change needed",
    );
  } else {
    await api(recordsPath, {
      type: "CNAME",
      name: target.domain,
      content: project.subdomain,
      ttl: 1,
      proxied: true,
    });
    log("Created the Pages CNAME record");
  }
  const current = await api(
    projectPath + "/domains/" + target.domain,
  );
  log(
    `Domain status: ${current.status}; certificate: ${current.validation_data?.status ?? "pending"}`,
  );
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  const api = async (path, body) => {
    const method = body ? "POST" : "GET";
    const response = await fetch(
      "https://api.cloudflare.com/client/v4" + path,
      {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      },
    );
    const data = await response.json();
    if (!response.ok || !data.success) {
      const details = data.errors
        ?.map((error) => `${error.code}: ${error.message}`)
        .join("; ");
      throw new Error(
        `${method} ${path}: HTTP ${response.status}; ${details ?? "Cloudflare API error"}`,
      );
    }
    return data.result;
  };
  await setupPagesDomain(process.argv[2], {
    api,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),
  });
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
