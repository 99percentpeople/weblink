import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export async function runNativeTests(
  command = "cargo",
  args = [
    "test",
    "--workspace",
    "--locked",
    "--release",
    "--features",
    "tauri/custom-protocol",
    "--message-format=json-render-diagnostics",
  ],
  write = console.log,
) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const binaries = new Set();
  let building = true;
  const read = async () => {
    for await (const line of createInterface({
      input: child.stdout,
    })) {
      let message;
      if (building && line.startsWith("{")) {
        try {
          message = JSON.parse(line);
        } catch {}
      }
      if (!message?.reason) {
        write(line);
        continue;
      }
      if (message.reason === "build-finished") {
        building = false;
      } else if (
        message.reason === "compiler-artifact" &&
        message.target?.name === "weblink_desktop_lib" &&
        message.profile?.test === true &&
        message.executable
      ) {
        binaries.add(message.executable);
      } else if (message.message?.rendered) {
        process.stderr.write(message.message.rendered);
      }
    }
  };
  const [[code, signal]] = await Promise.all([
    once(child, "close"),
    read(),
  ]);
  if (code !== 0 || signal)
    throw new Error(
      `Native tests failed (${signal ?? code})`,
    );
  if (binaries.size !== 1)
    throw new Error(
      "Expected exactly one desktop unit-test executable",
    );
  const [binary] = binaries;
  if (
    !isAbsolute(binary) ||
    /[\r\n]/.test(binary) ||
    !(await stat(binary)).isFile()
  )
    throw new Error("Invalid desktop test executable");
  return binary;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  const binary = await runNativeTests();
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `desktop-test-binary=${binary}\n`,
    );
}
