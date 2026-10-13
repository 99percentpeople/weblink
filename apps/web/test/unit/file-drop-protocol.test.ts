import { expect, it } from "vitest";
import { validFileDropRequest } from "@/libs/domain/protocol/file-drop";
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
