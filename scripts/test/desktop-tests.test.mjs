import assert from "node:assert/strict";
import { test } from "node:test";
import { runNativeTests } from "../desktop-tests.mjs";

const artifact = (executable, test = true) => ({
  reason: "compiler-artifact",
  target: { name: "weblink_desktop_lib" },
  profile: { test },
  executable,
});
const finished = {
  reason: "build-finished",
  success: true,
};
function cargo(lines, code = 0, write = () => {}) {
  const output = lines
    .map((line) =>
      typeof line === "string"
        ? line
        : JSON.stringify(line),
    )
    .join("\n");
  return runNativeTests(
    process.execPath,
    [
      "-e",
      `process.stdout.write(${JSON.stringify(output + "\n")}, () => process.exit(${code}));`,
    ],
    write,
  );
}

test("selects the compiled test executable and preserves test output", async () => {
  const output = [];
  const testLog = JSON.stringify(artifact("/test-output"));
  const binary = await cargo(
    [
      artifact("/ordinary-library", false),
      artifact(process.execPath),
      artifact(process.execPath),
      finished,
      "test result: ok",
      testLog,
    ],
    0,
    (line) => output.push(line),
  );
  assert.equal(binary, process.execPath);
  assert.deepEqual(output, ["test result: ok", testLog]);
});

test("fails when tests fail after a successful compilation", async () => {
  await assert.rejects(
    cargo([artifact(process.execPath), finished], 101),
    /Native tests failed \(101\)/,
  );
});

test("rejects missing or ambiguous test executables", async () => {
  for (const lines of [
    [artifact("/ordinary-library", false), finished],
    [
      artifact(process.execPath),
      artifact("/another-test-executable"),
      finished,
    ],
  ])
    await assert.rejects(
      cargo(lines),
      /Expected exactly one desktop unit-test executable/,
    );
});

test("rejects an executable that no longer exists", async () => {
  await assert.rejects(
    cargo([
      artifact(process.execPath + ".missing-test-fixture"),
      finished,
    ]),
    /ENOENT/,
  );
});
