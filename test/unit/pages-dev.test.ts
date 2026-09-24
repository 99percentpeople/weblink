// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareClient,
  getDevTarget,
  verifyDevDeployment,
} from "../../scripts/pages-dev.mjs";

const projectPath =
  "/accounts/account/pages/projects/weblink";
const target = "dev.weblink-main.pages.dev";

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

  it("accepts the manually configured development domain", async () => {
    const commit = "a".repeat(40);
    const fetcher = vi.fn(async () =>
      Response.json({
        channel: "dev",
        commit,
        version: "1.0.4-dev.aaaaaaa",
      }),
    );

    await expect(
      verifyDevDeployment(
        "dev.webl.ink",
        commit,
        fetcher,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ channel: "dev", commit });
  });

  it("does not probe arbitrary URLs", async () => {
    await expect(
      verifyDevDeployment("webl.ink", "a".repeat(40)),
    ).rejects.toThrow("unexpected");
  });
});
