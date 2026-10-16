import { expect, it } from "vitest";
import { localFileErrorDetail } from "@/libs/utils/local-file-error";

it.each([
  [
    "Access is denied. (os error 5)",
    "Access is denied. (os error 5)",
  ],
  [
    { name: "NotReadableError", message: "" },
    "NotReadableError",
  ],
  [
    new DOMException(
      "The selected file could not be read",
      "NotReadableError",
    ),
    "NotReadableError: The selected file could not be read",
  ],
  [
    {
      name: "SecurityError",
      message: "File access was blocked",
    },
    "SecurityError: File access was blocked",
  ],
  [
    new Error("Storage is unavailable", {
      cause: "Unknown directory capability",
    }),
    "Error: Storage is unavailable\nUnknown directory capability",
  ],
])(
  "preserves local file error details for %s",
  (error, expected) => {
    expect(localFileErrorDetail(error)).toBe(expected);
  },
);

it("keeps nested causes without exposing a stack or following a cycle", () => {
  const error = new Error("Cannot open file");
  error.cause = {
    name: "NotAllowedError",
    message: "Permission denied",
    cause: error,
  };
  expect(localFileErrorDetail(error)).toBe(
    "Error: Cannot open file\nNotAllowedError: Permission denied",
  );
});

it.each([
  null,
  undefined,
  {},
  "",
  { message: "", name: "Error" },
])("returns no invented diagnosis for %s", (error) => {
  expect(localFileErrorDetail(error)).toBeUndefined();
});
