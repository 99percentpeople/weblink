import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolchain = "nightly-2026-10-17";
const target = "x86_64-pc-windows-msvc";

if (process.platform !== "win32") {
  console.error(
    "Run the desktop size build on Windows with the MSVC build tools installed.",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const tauriArgs =
  separator < 0 ? args : args.slice(0, separator);
const cargoArgs =
  separator < 0 ? [] : args.slice(separator + 1);
const env = {
  ...process.env,
  RUSTUP_TOOLCHAIN: toolchain,
  CARGO_TARGET_DIR:
    process.env.CARGO_TARGET_DIR ??
    resolve(root, "target/desktop-size"),
};

// Dev CI overrides these for faster builds; this explicit preset owns them.
for (const key of [
  "OPT_LEVEL",
  "CODEGEN_UNITS",
  "LTO",
  "DEBUG",
  "STRIP",
  "PANIC",
]) {
  delete env[`CARGO_PROFILE_RELEASE_${key}`];
}

console.info(`Windows size build: ${toolchain}`);
const result = spawnSync(
  process.execPath,
  [
    "run",
    "--cwd",
    "apps/desktop",
    "build",
    "--target",
    target,
    ...tauriArgs,
    "--",
    "--locked",
    "--config",
    resolve(root, ".cargo/desktop-size.toml"),
    ...cargoArgs,
  ],
  { cwd: root, env, stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
