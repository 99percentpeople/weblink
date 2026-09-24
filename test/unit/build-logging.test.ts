// @vitest-environment node
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { transformWithEsbuild } from "vite";
import { getBuildLoggingOptions } from "../../scripts/build-logging";

const source = `
  debugger;
  console.log("verbose-log");
  console.debug("verbose-debug");
  console.trace("verbose-trace");
  console.debug(recordWork());
  console.info("connection-ready");
  console.warn("heartbeat-timeout");
  console.error("recovery-exhausted");
`;

async function compile(mode: string) {
  const result = await transformWithEsbuild(
    source,
    "logging-fixture.ts",
    { ...getBuildLoggingOptions(mode), minify: true },
  );
  const output = {
    log: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const recordWork = vi.fn(() => "side-effect-result");
  runInNewContext(result.code, {
    console: output,
    recordWork,
  });
  return { code: result.code, output, recordWork };
}

describe("production logging", () => {
  it("removes verbose calls and debugger but preserves diagnostics and argument side effects", async () => {
    const { code, output, recordWork } =
      await compile("production");

    expect(code).not.toMatch(
      /console\.(log|debug|trace)\b/,
    );
    expect(code).not.toContain("verbose-");
    expect(code).not.toContain("debugger");
    expect(output.log).not.toHaveBeenCalled();
    expect(output.debug).not.toHaveBeenCalled();
    expect(output.trace).not.toHaveBeenCalled();
    expect(output.info).toHaveBeenCalledWith(
      "connection-ready",
    );
    expect(output.warn).toHaveBeenCalledWith(
      "heartbeat-timeout",
    );
    expect(output.error).toHaveBeenCalledWith(
      "recovery-exhausted",
    );
    expect(recordWork).toHaveBeenCalledOnce();
  });

  it.each(["development", "test", "staging"])(
    "keeps debugging available in %s mode",
    async (mode) => {
      const { code, output, recordWork } =
        await compile(mode);

      expect(code).toContain("debugger");
      expect(output.log).toHaveBeenCalledWith(
        "verbose-log",
      );
      expect(output.debug).toHaveBeenCalledWith(
        "verbose-debug",
      );
      expect(output.trace).toHaveBeenCalledWith(
        "verbose-trace",
      );
      expect(output.info).toHaveBeenCalledWith(
        "connection-ready",
      );
      expect(output.warn).toHaveBeenCalledWith(
        "heartbeat-timeout",
      );
      expect(output.error).toHaveBeenCalledWith(
        "recovery-exhausted",
      );
      expect(recordWork).toHaveBeenCalledOnce();
    },
  );
});
