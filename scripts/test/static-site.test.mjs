import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { test } from "node:test";
import {
  contentHash,
  needsDeployment,
  prepareSite,
  verifyDeployment,
} from "../static-site.mjs";

async function fixture(t) {
  const directory = await mkdtemp(
    join(tmpdir(), "weblink-static-site-"),
  );
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(
      basename(directory).startsWith(
        "weblink-static-site-",
      ),
    );
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "index.html"), "Hello");
  return directory;
}

test("unchanged files keep their hash across commits, timestamps and manifest rewrites", async (t) => {
  const directory = await fixture(t);
  const first = await prepareSite(
    "www",
    directory,
    "first",
  );
  await utimes(join(directory, "index.html"), 1, 1);
  const second = await prepareSite(
    "www",
    directory,
    "second",
  );
  assert.equal(second.hash, first.hash);
  assert.equal(await contentHash(directory), first.hash);
  assert.notEqual(second.commit, first.commit);
});

test("content edits, additions, renames and deletions change the deployed hash", async (t) => {
  const directory = await fixture(t);
  const initial = await contentHash(directory);
  await writeFile(join(directory, "index.html"), "Updated");
  const edited = await contentHash(directory);
  assert.notEqual(edited, initial);
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "assets/a.css"),
    "body{}",
  );
  const added = await contentHash(directory);
  assert.notEqual(added, edited);
  await rename(
    join(directory, "assets/a.css"),
    join(directory, "assets/b.css"),
  );
  assert.notEqual(await contentHash(directory), added);
  await rm(join(directory, "assets/b.css"));
  assert.equal(await contentHash(directory), edited);
});

test("a missing homepage cannot produce a deployment manifest", async (t) => {
  const directory = await fixture(t);
  await rm(join(directory, "index.html"));
  await assert.rejects(prepareSite("docs", directory));
});

const expected = { site: "docs", hash: "a".repeat(64) };
const response = (value) => async () =>
  Response.json(value);

test("the published content, not the commit or app version, decides whether to deploy", async () => {
  assert.equal(
    await needsDeployment(
      expected,
      "https://example.com/",
      {
        fetchImpl: response({ ...expected, commit: "old" }),
      },
    ),
    false,
  );
  for (const remote of [
    { ...expected, hash: "b".repeat(64) },
    { ...expected, site: "www" },
    { version: "1.0.0" },
  ]) {
    assert.equal(
      await needsDeployment(
        expected,
        "https://example.com/",
        {
          fetchImpl: response(remote),
        },
      ),
      true,
    );
  }
});

test("first deployment and legacy HTML fallbacks are deployable", async () => {
  for (const fetchImpl of [
    async () => new Response("", { status: 404 }),
    async () =>
      new Response("<html>Old website</html>", {
        headers: { "content-type": "text/html" },
      }),
  ]) {
    assert.equal(
      await needsDeployment(
        expected,
        "https://example.com/",
        {
          fetchImpl,
        },
      ),
      true,
    );
  }
});

test("unreachable or failing sites do not silently cause repeat deployments", async () => {
  for (const fetchImpl of [
    async () => new Response("", { status: 503 }),
    async () => {
      throw new Error("Network unavailable");
    },
  ]) {
    await assert.rejects(
      needsDeployment(expected, "https://example.com/", {
        fetchImpl,
      }),
    );
    assert.equal(
      await needsDeployment(
        expected,
        "https://example.com/",
        {
          fetchImpl,
          force: true,
        },
      ),
      true,
    );
  }
});

test("verification waits for publication and rejects an unchanged old deployment", async () => {
  let requests = 0;
  await verifyDeployment(expected, "https://example.com/", {
    fetchImpl: async () =>
      Response.json(
        ++requests < 3
          ? { ...expected, hash: "old" }
          : expected,
      ),
    attempts: 3,
    delayMs: 0,
  });
  assert.equal(requests, 3);
  await assert.rejects(
    verifyDeployment(expected, "https://example.com/", {
      fetchImpl: response({ ...expected, hash: "old" }),
      attempts: 2,
      delayMs: 0,
    }),
    /does not match/,
  );
});
