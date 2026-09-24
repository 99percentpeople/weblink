// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  getDevTarget,
  configureDevDomain,
  createCloudflareClient,
  verifyDevDeployment,
} from "../../scripts/pages-dev.mjs";

const projectPath =
  "/accounts/account/pages/projects/weblink";
const target = "dev.weblink-main.pages.dev";
const dnsPath = "/zones/zone/dns_records";
const lookupPath = `${dnsPath}?name=dev.webl.ink`;
const domain = { name: "dev.webl.ink" };
const correctRecord = {
  id: "record",
  name: domain.name,
  type: "CNAME",
  content: target,
  proxied: true,
};

function apiHarness(
  records: unknown[] = [],
  domains: unknown[] = [],
) {
  return vi.fn(
    async (
      path: string,
      _method = "GET",
      _body?: unknown,
    ): Promise<any> => {
      if (path === "/zones?name=webl.ink")
        return [{ id: "zone", name: "webl.ink" }];
      if (path === lookupPath) return records;
      if (
        path === `${projectPath}/domains` &&
        _method === "GET"
      )
        return domains;
      return {};
    },
  );
}

describe("isolated Pages dev deployment", () => {
  it("resolves the real Pages subdomain instead of guessing from the project name", () => {
    expect(
      getDevTarget({
        production_branch: "public",
        subdomain: "weblink-main.pages.dev",
      }),
    ).toBe(target);
  });
  it.each([
    {
      production_branch: "dev",
      subdomain: "weblink-main.pages.dev",
    },
    { subdomain: "weblink-main.pages.dev" },
    {
      production_branch: "public",
      subdomain: "invalid\noutput",
    },
  ])(
    "rejects a production target or invalid project (%j)",
    (project) => {
      expect(() => getDevTarget(project)).toThrow();
    },
  );
  it("creates only the dev custom domain and a proxied branch-alias CNAME", async () => {
    const api = apiHarness();
    await configureDevDomain(api, projectPath, target);
    const writes = api.mock.calls.filter(
      ([, method]) => method && method !== "GET",
    );
    expect(writes).toEqual([
      [`${projectPath}/domains`, "POST", domain],
      [
        dnsPath,
        "POST",
        {
          type: "CNAME",
          name: domain.name,
          content: target,
          proxied: true,
          ttl: 1,
        },
      ],
    ]);
  });
  it("does not change an already configured domain", async () => {
    const api = apiHarness([correctRecord], [domain]);
    await configureDevDomain(api, projectPath, target);
    expect(
      api.mock.calls.filter(
        ([, method]) => method && method !== "GET",
      ),
    ).toEqual([]);
  });
  it("replaces only the exact dev record, never wildcard or production DNS", async () => {
    const api = apiHarness(
      [
        {
          ...correctRecord,
          content: "old-oss.example.com",
        },
      ],
      [domain],
    );
    await configureDevDomain(api, projectPath, target);
    expect(api).toHaveBeenCalledWith(
      `${dnsPath}/record`,
      "PATCH",
      {
        type: "CNAME",
        name: domain.name,
        content: target,
        proxied: true,
        ttl: 1,
      },
    );
  });
  it.each([
    { records: [{ ...correctRecord, name: "*.webl.ink" }] },
    {
      records: [
        correctRecord,
        { ...correctRecord, id: "another" },
      ],
    },
  ])(
    "rejects ambiguous records before any writes",
    async ({ records }) => {
      const api = apiHarness(records);
      await expect(
        configureDevDomain(api, projectPath, target),
      ).rejects.toThrow("Conflicting");
      expect(
        api.mock.calls.filter(
          ([, method]) => method && method !== "GET",
        ),
      ).toEqual([]);
    },
  );
  it("does not include credentials in API failure messages", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000 }],
          }),
          { status: 403 },
        ),
    );
    const api = createCloudflareClient(
      "private-token",
      fetcher as typeof fetch,
    );
    await expect(api(projectPath)).rejects.toThrow(
      "HTTP 403, codes 10000",
    );
  });
  it("waits for the tested dev commit, not stale or production content", async () => {
    const commit = "a".repeat(40);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          channel: "stable",
          commit,
          version: "1.0.4",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          channel: "dev",
          commit: "b".repeat(40),
          version: "1.0.4-dev.bbbbbbb",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          channel: "dev",
          commit,
          version: "1.0.4-dev.aaaaaaa",
        }),
      );
    const pause = vi.fn(async () => {});
    await expect(
      verifyDevDeployment(target, commit, fetcher, pause),
    ).resolves.toMatchObject({ channel: "dev", commit });
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it("does not probe arbitrary URLs", async () => {
    await expect(
      verifyDevDeployment("webl.ink", "a".repeat(40)),
    ).rejects.toThrow("unexpected");
  });
});
