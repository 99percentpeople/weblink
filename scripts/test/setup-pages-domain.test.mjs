import assert from "node:assert/strict";
import { test } from "node:test";
import { setupPagesDomain } from "../setup-pages-domain.mjs";

function cloudflare({ records = [], bound = true } = {}) {
  const writes = [];
  const domain = {
    name: "docs.webl.ink",
    status: "pending",
    zone_tag: "zone",
  };
  return {
    writes,
    api: async (path, body) => {
      if (body) {
        writes.push({ path, body });
        return path.endsWith("/domains") ? domain : body;
      }
      if (path.startsWith("/accounts?"))
        return [{ id: "account" }];
      if (path.endsWith("/weblink-docs"))
        return {
          production_branch: "public",
          subdomain: "weblink-docs.pages.dev",
        };
      if (path.endsWith("/domains"))
        return bound ? [domain] : [];
      if (path.includes("/dns_records?")) return records;
      if (path.endsWith("/domains/docs.webl.ink"))
        return domain;
      throw new Error("Unexpected request: " + path);
    },
  };
}

test("initial setup binds the domain before creating its CNAME", async () => {
  const service = cloudflare({ bound: false });
  await setupPagesDomain("docs", {
    api: service.api,
    log() {},
  });
  assert.deepEqual(
    service.writes.map((entry) => entry.body),
    [
      { name: "docs.webl.ink" },
      {
        type: "CNAME",
        name: "docs.webl.ink",
        content: "weblink-docs.pages.dev",
        ttl: 1,
        proxied: true,
      },
    ],
  );
});

test("repeated setup leaves an existing matching domain and DNS unchanged", async () => {
  const service = cloudflare({
    records: [
      { type: "CNAME", content: "weblink-docs.pages.dev." },
    ],
  });
  await setupPagesDomain("docs", {
    api: service.api,
    log() {},
  });
  assert.deepEqual(service.writes, []);
});

test("setup refuses to replace existing DNS records", async () => {
  const service = cloudflare({
    records: [{ type: "A", content: "192.0.2.1" }],
  });
  await assert.rejects(
    setupPagesDomain("docs", {
      api: service.api,
      log() {},
    }),
    /Existing DNS records differ/,
  );
  assert.deepEqual(service.writes, []);
});

test("setup requires an explicit account when the token can access multiple accounts", async () => {
  await assert.rejects(
    setupPagesDomain("docs", {
      api: async () => [{ id: "one" }, { id: "two" }],
      log() {},
    }),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
});
