import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
];

function run(
  command,
  args,
  { cwd = root, input, inherit = false, signal } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      signal,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        inherit ? "inherit" : "pipe",
        "inherit",
      ],
    });
    const output = [];
    child.stdout?.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(output).toString("utf8"))
        : reject(
            new Error(`${command} exited with ${code}`),
          ),
    );
    if (input !== undefined) {
      // Early SSH failure may close stdin before rsync reads the file list.
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(input);
    }
  });
}

export function allowedPath(path) {
  const parts = path.split("/");
  return (
    path !== "" &&
    !path.includes("\\") &&
    !/[\r\n\0]/.test(path) &&
    !path.includes(":") &&
    parts.every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        ![
          ".git",
          ".tmp",
          "node_modules",
          "target",
          "dist",
          "dev-dist",
          ".wrangler",
          "coverage",
        ].includes(part) &&
        !(
          part.startsWith(".env") && part !== ".env.example"
        ) &&
        !part.startsWith(".dev.vars"),
    )
  );
}

async function statIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      return null;
    throw error;
  }
}

/** Git is the source inventory, including untracked source and initialized submodules. */
export async function snapshot(sourceRoot) {
  const files = [];
  const signatures = [];
  async function visit(repository) {
    const prefix = relative(sourceRoot, repository)
      .split("\\")
      .join("/");
    const index = await run(
      "git",
      ["ls-files", "--stage", "-z"],
      { cwd: repository },
    );
    for (const entry of index.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const name = entry.slice(entry.indexOf("\t") + 1);
      if (
        !(await statIfPresent(
          join(repository, name, ".git"),
        ))
      ) {
        throw new Error(
          `Initialize the submodule before syncing: ${prefix ? `${prefix}/` : ""}${name}`,
        );
      }
    }
    const listed = await run(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { cwd: repository },
    );
    for (const name of new Set(
      listed.split("\0").filter(Boolean),
    )) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!allowedPath(path)) continue;
      const full = join(sourceRoot, path);
      const stat = await statIfPresent(full);
      if (!stat) continue;
      if (stat.isSymbolicLink())
        throw new Error(
          `Source symlinks are not supported by source sync: ${path}`,
        );
      if (stat.isDirectory()) {
        if (!(await statIfPresent(join(full, ".git"))))
          throw new Error(
            `Initialize the submodule before syncing: ${path}`,
          );
        await visit(full);
      } else if (stat.isFile()) {
        files.push(path);
        signatures.push(
          JSON.stringify([
            path,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs,
          ]),
        );
      }
    }
  }
  await visit(sourceRoot);
  return {
    files: files.sort(),
    signature: createHash("sha256")
      .update(signatures.sort().join("\n"))
      .digest("hex"),
  };
}

/** Delete only vanished files previously managed by this script, never remote-only files. */
export async function removedFiles(
  sourceRoot,
  current,
  previous,
) {
  const files = new Set();
  for (const path of previous) {
    if (
      !current.includes(path) &&
      allowedPath(path) &&
      !(await statIfPresent(join(sourceRoot, path)))
    )
      files.add(path);
  }
  return [...files].sort();
}

export function rsyncArgs(
  sourceRoot,
  destination,
  backup,
  filterFile,
  extra = [],
  dryRun = false,
) {
  return [
    "--times",
    "--omit-dir-times",
    "--no-perms",
    "--no-owner",
    "--no-group",
    "--checksum",
    "--recursive",
    "--delete-delay",
    `--filter=merge ${filterFile}`,
    "--delay-updates",
    "--backup",
    `--backup-dir=${backup}`,
    "--itemize-changes",
    "--human-readable",
    "--protect-args",
    "--timeout=60",
    ...extra,
    ...(dryRun ? ["--dry-run"] : []),
    "--",
    `${sourceRoot.replace(/\/$/, "")}/`,
    destination,
  ];
}

export function syncTarget(env = process.env) {
  const configured = env.WEBLINK_SYNC_TARGET || "";
  const match = /^([\w.@-]+):(.+)$/.exec(configured);
  if (
    !match ||
    match[1].startsWith("-") ||
    match[2].startsWith(":")
  ) {
    throw new Error(
      "Set WEBLINK_SYNC_TARGET=user@host:/path/to/weblink in root .env",
    );
  }
  const [, host, path] = match;
  const destination = path.replace(/\/+$/, "");
  if (
    !destination ||
    [".", "~"].includes(destination) ||
    /[\r\n\0\\]/.test(destination) ||
    destination
      .split("/")
      .some((p) => p === "." || p === "..")
  ) {
    throw new Error(
      "WEBLINK_SYNC_TARGET must name a project directory",
    );
  }
  const binary = env.WEBLINK_SYNC_RSYNC || "rsync";
  if (/[\r\n\0]/.test(binary))
    throw new Error("Invalid WEBLINK_SYNC_RSYNC");
  // This is a program path, not a shell command. Support Windows drive paths as
  // well as POSIX executables; all source/destination paths use rsync's protocol.
  let remoteProgram;
  if (/^[a-z]:[\\/]/i.test(binary)) {
    if (/[%"&|<>^]/.test(binary))
      throw new Error(
        "Unsupported character in the Windows rsync path",
      );
    remoteProgram = `"${binary.replaceAll("\\", "/")}"`;
  } else {
    remoteProgram = /^[\w./-]+$/.test(binary)
      ? binary
      : "'" + binary.replaceAll("'", "'\\''") + "'";
  }
  return { host, destination, remoteProgram };
}

/** Sender allowlist + receiver protection: delete only explicitly managed removals. */
export function syncFilter(files, removed) {
  const escape = (path) =>
    path.replace(/[\\*?[]/g, (char) => `\\${char}`);
  const parents = (paths) => {
    const dirs = new Set();
    for (const path of paths) {
      const parts = path.split("/");
      parts.pop();
      while (parts.length) {
        dirs.add(parts.join("/"));
        parts.pop();
      }
    }
    return [...dirs].sort();
  };
  return [
    ...parents(files).map((path) => `+s /${escape(path)}/`),
    ...files.map((path) => `+s /${escape(path)}`),
    "-s *",
    ...parents(removed).map(
      (path) => `R /${escape(path)}/`,
    ),
    ...removed.map((path) => `R /${escape(path)}`),
    "P *",
    "",
  ].join("\n");
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(`Invalid sync lock: ${path}`);
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          await rm(path, { force: true });
          continue;
        }
        throw error;
      }
      throw new Error(
        `Sync is already running (PID ${pid})`,
      );
    }
  }
  throw new Error(`Could not acquire sync lock: ${path}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log(
      "bun run sync [--dry-run]\nbun run sync:watch\nConfiguration: WEBLINK_SYNC_TARGET, WEBLINK_SYNC_RSYNC in root .env",
    );
    return;
  }
  if (
    [...args].some(
      (arg) => !["--watch", "--dry-run"].includes(arg),
    ) ||
    (args.has("--watch") && args.has("--dry-run"))
  )
    throw new Error("Use --watch or --dry-run; see --help");
  await run("rsync", ["--version"]);
  const target = syncTarget();
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        host: target.host,
        destination: target.destination,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const stateFile = join(
    root,
    ".tmp",
    "sync",
    `${id}.json`,
  );
  await mkdir(dirname(stateFile), { recursive: true });
  const unlock = await acquireLock(`${stateFile}.lock`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let previous = [];
    try {
      const saved = JSON.parse(
        await readFile(stateFile, "utf8"),
      );
      if (
        !Array.isArray(saved.files) ||
        saved.files.some(
          (p) => typeof p !== "string" || !allowedPath(p),
        )
      )
        throw new Error(`Invalid sync state: ${stateFile}`);
      previous = saved.files;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const sync = async (current) => {
      const removed = await removedFiles(
        root,
        current.files,
        previous,
      );
      const stamp = new Date()
        .toISOString()
        .replaceAll(":", "-");
      const backup = `.tmp/rsync-backups/${stamp}`;
      const filterFile = `${stateFile}.filter`;
      await writeFile(
        filterFile,
        syncFilter(current.files, removed),
      );
      console.log(
        `[sync] ${args.has("--dry-run") ? "Preview" : "Sending"} ${current.files.length} source files → ${target.host}:${target.destination}`,
      );
      await run(
        "rsync",
        rsyncArgs(
          root,
          `${target.host}:${target.destination}/`,
          backup,
          filterFile,
          [
            "-e",
            ["ssh", ...sshOptions].join(" "),
            `--rsync-path=${target.remoteProgram}`,
          ],
          args.has("--dry-run"),
        ),
        {
          inherit: true,
          signal: controller.signal,
        },
      );
      if (!args.has("--dry-run")) {
        await writeFile(
          `${stateFile}.new`,
          JSON.stringify({ files: current.files }) + "\n",
        );
        await rename(`${stateFile}.new`, stateFile);
        previous = current.files;
      }
      console.log(
        `[sync] ${args.has("--dry-run") ? "Preview complete" : "Complete"}`,
      );
    };

    let current = await snapshot(root);
    let synced;
    let observed = current.signature;
    let changedAt = Date.now();
    let attemptedAt = 0;
    const attempt = async () => {
      try {
        await sync(current);
        synced = current.signature;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!args.has("--watch")) throw error;
        console.error(
          `[sync] ${error.message}; retrying in 3 seconds`,
        );
      }
      attemptedAt = Date.now();
    };
    await attempt();
    if (!args.has("--watch")) return;
    console.log(
      "[watch] Checking source changes every second; Ctrl+C to stop.",
    );
    // Poll only Git-visible source: no recursive watchers on node_modules/target,
    // and new files, removals and submodule changes are all discovered.
    while (!controller.signal.aborted) {
      await sleep(1000, undefined, {
        signal: controller.signal,
      });
      current = await snapshot(root);
      if (current.signature !== observed) {
        observed = current.signature;
        changedAt = Date.now();
      }
      if (
        current.signature !== synced &&
        Date.now() - changedAt >= 750 &&
        Date.now() - attemptedAt >= 3000
      )
        await attempt();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await unlock();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    import.meta.url
) {
  main().catch((error) => {
    console.error(`[sync] ${error.message}`);
    process.exitCode = 1;
  });
}
