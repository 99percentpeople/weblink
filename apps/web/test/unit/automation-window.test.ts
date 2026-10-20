import { expect, it } from "vitest";
import { parseCall } from "@weblink/automation";

it("binds only opaque windows under input permission", () => {
  expect(
    parseCall({
      name: "control.bindWindow",
      arguments: {
        target: "local",
        windowId: "owned-window-reference",
      },
    }).scope,
  ).toBe("input.control");
  expect(
    parseCall({
      name: "control.bindWindow",
      arguments: {
        target: "peer",
        windowId: "remote-window-reference",
      },
    }).native,
  ).toBe(true);
  for (const args of [
    {},
    { windowId: "" },
    { windowId: 123 },
    { hwnd: 123 },
    { windowId: "ref", focus: false },
    { windowId: "ref", processId: 123 },
  ]) {
    expect(() =>
      parseCall({
        name: "control.bindWindow",
        arguments: { target: "local", ...args },
      }),
    ).toThrow();
  }
});
