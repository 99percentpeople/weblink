import { describe, expect, it } from "vitest";
import {
  parseCall,
  type ScreenshotArguments,
} from "@weblink/automation";

describe("screenshot arguments across MCP and WebMCP", () => {
  const base = {
    target: "local",
    sourceId: "window:source",
  };
  it("accepts existing calls and higher resolution desktop crops", () => {
    const crop: ScreenshotArguments = {
      ...base,
      target: "peer",
      maxWidth: 2048,
      maxHeight: 1200,
      rect: {
        left: -1800,
        top: -100,
        width: 600,
        height: 400,
      },
    };
    for (const args of [base, crop]) {
      const tool = parseCall({
        name: "control.screenshot",
        arguments: { ...args },
      });
      expect(tool.scope).toBe("screen.read");
      expect(tool.readOnly).toBe(true);
    }
  });
  it("rejects invalid output limits and ambiguous crop coordinates", () => {
    for (const extra of [
      { maxWidth: 0 },
      { maxWidth: 2049 },
      { maxHeight: 2049 },
      { maxHeight: 1.5 },
      { rect: { left: 0, top: 0, width: 0, height: 10 } },
      { rect: { left: 0, top: 0, width: 10 } },
      { rect: { x: 0, y: 0, width: 10, height: 10 } },
      {
        rect: { left: 0.5, top: 0, width: 10, height: 10 },
      },
      {
        rect: {
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          relative: true,
        },
      },
      { coordinateSpace: "windowPixels" },
      { rect: null },
    ]) {
      expect(() =>
        parseCall({
          name: "control.screenshot",
          arguments: { ...base, ...extra },
        }),
      ).toThrow();
    }
  });
});
