import { expect, it } from "vitest";
import { parseCall } from "@weblink/automation";

const read = (selector: Record<string, unknown>) =>
  parseCall({
    name: "commands.read",
    arguments: {
      target: "local",
      jobId: "job",
      ...selector,
    },
  });

it("allows tail snapshots and absolute cursors beyond the retained buffer size", () => {
  for (const selector of [
    {},
    { cursor: 0 },
    { cursor: 4194305 },
    { cursor: Number.MAX_SAFE_INTEGER },
    { tailBytes: 1 },
    { tailBytes: 16384 },
    { tailLines: 1 },
    { tailLines: 1000 },
  ]) {
    expect(read(selector).scope).toBe("shell.execute");
    expect(read(selector).native).toBe(true);
  }
});

it("rejects ambiguous modes and invalid bounds before dispatch", () => {
  for (const selector of [
    { cursor: 0, tailBytes: 1 },
    { cursor: 0, tailLines: 1 },
    { tailBytes: 1, tailLines: 1 },
    { cursor: -1 },
    { cursor: 0.5 },
    { cursor: Number.MAX_SAFE_INTEGER + 1 },
    { cursor: null },
    { cursor: "3" },
    { tailBytes: 0 },
    { tailBytes: 16385 },
    { tailLines: 0 },
    { tailLines: 1001 },
    { tailLines: 1.5 },
    { tail: true },
    { jobId: "" },
    { target: "" },
  ]) {
    expect(() => read(selector)).toThrow();
  }
  expect(() =>
    parseCall({
      name: "commands.read",
      arguments: { target: "local", cursor: 0 },
    }),
  ).toThrow();
});
