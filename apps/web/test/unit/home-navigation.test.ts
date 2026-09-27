import { describe, expect, it } from "vitest";
import {
  conversationHref,
  isHomePath,
  sharedFilesHref,
} from "@/libs/application/home-navigation";

describe("Home navigation", () => {
  it("builds canonical panel URLs", () => {
    const conversation = new URL(
      conversationHref('room:["local","team/a b"]'),
      "https://example.test",
    );
    expect(conversation.pathname).toBe("/");
    expect(conversation.searchParams.get("panel")).toBe(
      "chat",
    );
    expect(
      conversation.searchParams.get("conversation"),
    ).toBe('room:["local","team/a b"]');

    const files = new URL(
      sharedFilesHref("peer/a b"),
      "https://example.test",
    );
    expect(files.pathname).toBe("/");
    expect(files.searchParams.get("panel")).toBe("files");
    expect(files.searchParams.get("member")).toBe(
      "peer/a b",
    );
  });

  it("treats only the root route as the meeting page", () => {
    expect(isHomePath("/")).toBe(true);
    expect(isHomePath("//")).toBe(true);
    for (const path of [
      "/home",
      "/video",
      "/chat",
      "/file",
      "/setting",
      "/conversation/room",
      "/client/peer/sync",
      "/share",
    ])
      expect(isHomePath(path)).toBe(false);
  });
});
