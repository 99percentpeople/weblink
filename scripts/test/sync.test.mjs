import assert from "node:assert/strict";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowedPath,
  snapshot,
  removedFiles,
  rsyncArgs,
  syncFilter,
  syncTarget,
} from "../sync.mjs";

async function fixture(t) {
  const dir = await mkdtemp(
    join(tmpdir(), "weblink-sync-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function put(root, name, content) {
  const file = join(root, name);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}
function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("inventory includes current and untracked submodule sources but excludes local configuration and outputs", async (t) => {
  const root = await fixture(t);
  git(root, "init", "-q");
  await put(root, ".gitignore", "ignored.txt\n");
  await put(root, "source.txt", "one");
  git(root, "add", ".");
  for (const file of [
    ".env",
    ".env.local",
    "node_modules/leak",
    "target/leak",
    ".tmp/IMPLEMENTATION_PLAN.md",
    "ignored.txt",
  ])
    await put(root, file, "local");
  await put(root, ".env.example", "example");
  await put(root, "new file 中文.txt", "new");
  const sub = join(root, "servers", "sample");
  await mkdir(sub, { recursive: true });
  git(sub, "init", "-q");
  await put(sub, "server.ts", "server");
  git(sub, "add", ".");
  git(
    sub,
    "-c",
    "user.name=Sync Test",
    "-c",
    "user.email=sync@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "initial",
  );
  const commit = git(sub, "rev-parse", "HEAD");
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${commit},servers/sample`,
  );
  await put(sub, "untracked.ts", "new server");
  await put(sub, ".env", "secret");
  const before = await snapshot(root);
  assert.deepEqual(before.files, [
    ".env.example",
    ".gitignore",
    "new file 中文.txt",
    "servers/sample/server.ts",
    "servers/sample/untracked.ts",
    "source.txt",
  ]);
  await put(sub, "untracked.ts", "changed");
  assert.notEqual(
    (await snapshot(root)).signature,
    before.signature,
  );
  await rm(sub, { recursive: true });
  await assert.rejects(
    snapshot(root),
    /Initialize the submodule/,
  );
});

test("rsync backs up overwrites and propagates managed deletions while keeping Windows-only files", async (t) => {
  const root = await fixture(t);
  const source = join(root, "source");
  const remote = join(root, "remote");
  await mkdir(source);
  await mkdir(remote);
  await put(source, "src/你好 space.txt", "local v1");
  await put(source, "src/remove.txt", "to remove");
  await put(source, "removed-dir/[literal].txt", "nested");
  await put(remote, "removed-dir/only-remote.txt", "keep");
  await put(remote, "src/你好 space.txt", "Windows edit");
  for (const file of [
    ".env",
    ".git/config",
    "node_modules/local.txt",
    "target/local.txt",
    "only-on-windows.txt",
  ])
    await put(remote, file, "keep");
  const initial = [
    "src/remove.txt",
    "src/你好 space.txt",
    "removed-dir/[literal].txt",
  ];
  async function sync(
    files,
    name,
    dryRun = false,
    removed = [],
  ) {
    const filter = join(root, "filter");
    await writeFile(filter, syncFilter(files, removed));
    const result = spawnSync(
      "rsync",
      rsyncArgs(
        source,
        `${remote}/`,
        `${remote}/.tmp/backups/${name}`,
        filter,
        [],
        dryRun,
      ),
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  await sync(initial, "preview", true);
  assert.equal(
    await readFile(
      join(remote, "src/你好 space.txt"),
      "utf8",
    ),
    "Windows edit",
  );
  await sync(initial, "first");
  assert.equal(
    await readFile(
      join(remote, "src/你好 space.txt"),
      "utf8",
    ),
    "local v1",
  );
  assert.equal(
    await readFile(
      join(remote, ".tmp/backups/first/src/你好 space.txt"),
      "utf8",
    ),
    "Windows edit",
  );
  await rm(join(source, "src/remove.txt"));
  await rm(join(source, "removed-dir"), {
    recursive: true,
  });
  await put(source, "src/你好 space.txt", "local v2");
  const current = ["src/你好 space.txt"];
  await sync(
    current,
    "second",
    false,
    await removedFiles(source, current, initial),
  );
  await assert.rejects(
    readFile(join(remote, "src/remove.txt")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(join(remote, "removed-dir/[literal].txt")),
    { code: "ENOENT" },
  );
  assert.equal(
    await readFile(
      join(remote, "removed-dir/only-remote.txt"),
      "utf8",
    ),
    "keep",
  );
  assert.equal(
    await readFile(
      join(remote, ".tmp/backups/second/src/remove.txt"),
      "utf8",
    ),
    "to remove",
  );
  for (const file of [
    ".env",
    ".git/config",
    "node_modules/local.txt",
    "target/local.txt",
    "only-on-windows.txt",
  ])
    assert.equal(
      await readFile(join(remote, file), "utf8"),
      "keep",
    );
});

test("uses ordinary SSH targets for POSIX and Windows without remote PowerShell", () => {
  assert.deepEqual(
    syncTarget({
      WEBLINK_SYNC_TARGET:
        "user@linux:/home/user/my project",
    }),
    {
      host: "user@linux",
      destination: "/home/user/my project",
      remoteProgram: "rsync",
    },
  );
  assert.equal(
    syncTarget({
      WEBLINK_SYNC_TARGET: "mac:/Users/name/project",
      WEBLINK_SYNC_RSYNC: "/opt/homebrew/bin/rsync",
    }).remoteProgram,
    "/opt/homebrew/bin/rsync",
  );
  assert.equal(
    syncTarget({
      WEBLINK_SYNC_TARGET:
        "pc:/cygdrive/c/Users/name/project",
      WEBLINK_SYNC_RSYNC:
        "C:/Program Files/cwrsync/bin/rsync.exe",
    }).remoteProgram,
    '"C:/Program Files/cwrsync/bin/rsync.exe"',
  );
  for (const target of [
    "",
    "host:/",
    "host:../",
    "--evil:/path",
    "host::module",
  ])
    assert.throws(() =>
      syncTarget({ WEBLINK_SYNC_TARGET: target }),
    );
});

test("a file that becomes ignored is not deleted and unsafe manifest paths are rejected", async (t) => {
  const root = await fixture(t);
  await put(root, "now-ignored.txt", "local");
  assert.deepEqual(
    await removedFiles(
      root,
      [],
      [
        "now-ignored.txt",
        "../other",
        ".env",
        ".git/config",
      ],
    ),
    [],
  );
  for (const path of [
    "../other",
    "/absolute",
    "a/../../other",
    "a\\..\\other",
    "C:/file",
    ".tmp/plan.md",
    ".env.local",
  ])
    assert.equal(allowedPath(path), false, path);
  assert.equal(
    allowedPath("servers/server/.env.example"),
    true,
  );
});
