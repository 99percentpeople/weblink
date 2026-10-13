import { expect, it } from "vitest";
import {
  validFileDropRequest,
  validFileDropPosition,
} from "@/libs/domain/protocol/file-drop";
import { validCurrentCapability } from "@/libs/domain/protocol/capabilities";

const hover = {
  action: "hover",
  operationId: "operation",
  grantId: "grant",
  destination: {
    sourceId: "screen",
    mediaId: "media",
    geometryRevision: "layout",
  },
  point: { x: 0.25, y: 0.75 },
  types: ["image/png", "application/pdf"],
};

it("negotiates unacknowledged hover updates without enabling them for old peers", () => {
  expect(
    validCurrentCapability("fileDrop", {
      hover: true,
      hoverUpdates: true,
    }),
  ).toBe(true);
  expect(
    validCurrentCapability("fileDrop", {
      hoverUpdates: true,
    }),
  ).toBe(false);
  expect(
    validCurrentCapability("fileDrop", {
      hover: true,
      hoverUpdates: "true",
    }),
  ).toBe(false);
});
it("requires bounded positions, scope and a monotonic-safe sequence for notifications", () => {
  const position = {
    operationId: "operation",
    grantId: "grant",
    sequence: 1,
    point: hover.point,
  };
  expect(validFileDropPosition(position)).toBe(true);
  for (const change of [
    { operationId: "" },
    { grantId: "" },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { point: { x: 2, y: 0 } },
    { point: { x: 0, y: NaN } },
    { point: undefined },
  ])
    expect(
      validFileDropPosition({ ...position, ...change }),
    ).toBe(false);
});

it("accepts bounded hover metadata without changing legacy file-drop capabilities", () => {
  expect(validFileDropRequest(hover)).toBe(true);
  expect(
    validFileDropRequest({ ...hover, types: [] }),
  ).toBe(true);
  expect(validCurrentCapability("fileDrop", {})).toBe(true);
  expect(
    validCurrentCapability("fileDrop", { hover: true }),
  ).toBe(true);
  expect(
    validCurrentCapability("fileDrop", { hover: "true" }),
  ).toBe(false);
});

it.each([
  { types: Array(17).fill("image/png") },
  { types: ["a".repeat(129)] },
  { types: ["image/png\napplication/pdf"] },
  { types: [7] },
  { types: undefined },
  { point: { x: -0.1, y: 0.5 } },
  { point: { x: 0.5, y: Infinity } },
  { size: 4096 },
  { maxFileBytes: 4096 },
  { action: "prepare" },
])(
  "rejects malformed or mixed hover payloads: %j",
  (change) => {
    expect(
      validFileDropRequest({ ...hover, ...change }),
    ).toBe(false);
  },
);
