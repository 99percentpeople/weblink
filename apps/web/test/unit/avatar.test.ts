import { describe, expect, it } from "vitest";

import {
  getDefaultProfile,
  normalizeStoredProfile,
} from "@/libs/state/profile-store";
import { getAvatarFallbackStyle } from "@/libs/utils/avatar";
import { getInitials } from "@/libs/utils/name";

describe("avatar fallback", () => {
  it("keeps the default avatar field empty", () => {
    expect(getDefaultProfile().avatar).toBeNull();
  });

  it("migrates legacy DiceBear defaults without clearing custom avatars", () => {
    const profile = getDefaultProfile();

    expect(
      normalizeStoredProfile({
        ...profile,
        avatar:
          "https://api.dicebear.com/9.x/initials/svg?seed=Alice",
      }).avatar,
    ).toBeNull();

    expect(
      normalizeStoredProfile({
        ...profile,
        avatar: "data:image/png;base64,custom",
      }).avatar,
    ).toBe("data:image/png;base64,custom");
  });

  it("renders deterministic local colors from the display name", () => {
    expect(getAvatarFallbackStyle("Alice")).toEqual(
      getAvatarFallbackStyle("Alice"),
    );
    expect(
      getAvatarFallbackStyle("Alice").background,
    ).not.toBe(getAvatarFallbackStyle("Bob").background);
  });

  it("uses compact initials for western and CJK names", () => {
    expect(getInitials("Alice Smith")).toBe("AS");
    expect(getInitials("Alice")).toBe("AL");
    expect(getInitials("张三")).toBe("张三");
    expect(getInitials("")).toBe("?");
  });
});
