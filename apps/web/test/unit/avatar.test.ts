import { describe, expect, it } from "vitest";

import {
  getDefaultProfile,
  normalizeStoredProfile,
} from "@/libs/state/profile-store";
import {
  getAvatarFallbackColors,
  getAvatarFallbackSvg,
  getAvatarFallbackImage,
} from "@/libs/utils/avatar";
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
    expect(getAvatarFallbackColors("Alice")).toEqual(
      getAvatarFallbackColors("Alice"),
    );
    expect(getAvatarFallbackColors("Alice")).not.toEqual(
      getAvatarFallbackColors("Bob"),
    );
  });

  it("uses compact initials for western and CJK names", () => {
    expect(getInitials("Alice Smith")).toBe("AS");
    expect(getInitials("Alice")).toBe("AL");
    expect(getInitials("张三")).toBe("张三");
    expect(getInitials("")).toBe("?");
  });
});

describe("shared SVG avatars", () => {
  it("keeps names as text, including XML special characters", () => {
    const document = new DOMParser().parseFromString(
      getAvatarFallbackSvg("& <script>"),
      "image/svg+xml",
    );
    expect(
      document.querySelector("parsererror"),
    ).toBeNull();
    expect(document.documentElement.localName).toBe("svg");
    expect(document.querySelector("script")).toBeNull();
    expect(
      document.querySelector("text")?.textContent,
    ).toBe("&<");
  });
  it.each([
    "Alice Smith",
    "张三",
    "",
    "🙂",
    "A\u0000",
    "\uD800",
  ])("provides a reusable SVG image for %s", (name) => {
    const source = getAvatarFallbackImage(name);
    expect(source.startsWith("data:image/svg+xml,")).toBe(
      true,
    );
    expect(decodeURIComponent(source.split(",")[1])).toBe(
      getAvatarFallbackSvg(name),
    );
    expect(getAvatarFallbackImage(name)).toBe(source);
    const document = new DOMParser().parseFromString(
      decodeURIComponent(source.split(",")[1]),
      "image/svg+xml",
    );
    expect(
      document.querySelector("parsererror"),
    ).toBeNull();
  });
});
