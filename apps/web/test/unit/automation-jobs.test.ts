import { expect, it } from "vitest";
import { parseCall } from "@weblink/automation";

it("discovers command capabilities with read-only permission on the explicit target", () => {
  for (const target of ["local", "remote-device"]) {
    expect(
      parseCall({
        name: "commands.capabilities",
        arguments: { target },
      }),
    ).toMatchObject({
      scope: "diagnostics.read",
      readOnly: true,
      native: true,
    });
  }
  for (const args of [
    {},
    { target: "" },
    { target: "local", jobId: "job" },
    { target: "local", signal: "SIGKILL" },
  ]) {
    expect(() =>
      parseCall({
        name: "commands.capabilities",
        arguments: args,
      }),
    ).toThrow();
  }
});

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

const send = (action: Record<string, unknown>) =>
  parseCall({
    name: "commands.send",
    arguments: { target: "local", jobId: "job", ...action },
  });

it("allows bounded stdin, EOF and supported signal names for the original shell permission", () => {
  for (const action of [
    { input: "中文🙂\n" },
    { input: "\u0000\u0003\u0004\t\r\n" },
    { input: "🙂".repeat(16384), eof: true },
    { input: "line\n", eof: false },
    { eof: true },
    { signal: "SIGINT" },
    { signal: "SIGTERM" },
    { signal: "SIGKILL" },
  ]) {
    expect(send(action)).toMatchObject({
      scope: "shell.execute",
      native: true,
      readOnly: false,
    });
  }
});

it("rejects ambiguous or unbounded sends and removes the old cancel tool", () => {
  for (const action of [
    {},
    { input: "" },
    { input: "🙂".repeat(16385) },
    { eof: false },
    { eof: null },
    { eof: "true" },
    { signal: "SIGKILL", input: "text" },
    { signal: "SIGTERM", eof: true },
    { signal: "STOP" },
    { signal: 9 },
    { input: "text", extra: true },
    { jobId: "", input: "text" },
  ]) {
    expect(() => send(action)).toThrow();
  }
  expect(() =>
    parseCall({
      name: "commands.cancel",
      arguments: { target: "local", jobId: "job" },
    }),
  ).toThrow();
});
