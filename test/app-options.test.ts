import { describe, expect, it } from "vitest";
import { getDefaultAppOptions } from "@/libs/state/app-options";

describe("app options", () => {
  it("does not expose the signaling URL as a user option", () => {
    expect(getDefaultAppOptions()).not.toHaveProperty(
      "websocketUrl",
    );
  });
});
