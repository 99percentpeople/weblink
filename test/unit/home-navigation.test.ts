import { describe, expect, it } from "vitest";
import {
  conversationHref,
  isHomePath,
  legacyHomeHref,
} from "@/libs/application/home-navigation";
import { directConversationId } from "@/libs/domain/conversation";

describe("Home navigation compatibility", () => {
  it("keeps conversation identity, invite parameters and media hashes", () => {
    const id = 'room:["local","team/a b"]';
    const target = legacyHomeHref(
      {
        pathname: `/conversation/${encodeURIComponent(id)}`,
        search: "?id=team&pwd=secret",
        hash: "#/media/room/photo",
      },
      "self",
    );
    const url = new URL(target, "https://example.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("conversation")).toBe(id);
    expect(url.searchParams.get("id")).toBe("team");
    expect(url.searchParams.get("pwd")).toBe("secret");
    expect(url.hash).toBe("#/media/room/photo");
    expect(
      new URL(conversationHref(id), url).searchParams.get(
        "conversation",
      ),
    ).toBe(id);
  });

  it("routes old private chats and page entries into Home", () => {
    const legacy = (pathname: string) =>
      new URL(
        legacyHomeHref(
          { pathname, search: "", hash: "" },
          "uid_local",
        ),
        "https://example.test",
      );
    expect(
      legacy("/client/peer/chat").searchParams.get(
        "conversation",
      ),
    ).toBe(directConversationId("uid_local", "peer"));
    expect(
      legacy("/client/peer/sync").searchParams.get("panel"),
    ).toBe("files");
    expect(
      legacy("/client/peer/sync").searchParams.get(
        "member",
      ),
    ).toBe("peer");
    expect(legacy("/file").searchParams.get("dialog")).toBe(
      "files",
    );
    expect(
      legacy("/setting").searchParams.get("dialog"),
    ).toBe("settings");
    expect(legacy("/chat").searchParams.get("panel")).toBe(
      "conversations",
    );
    expect(() =>
      legacy("/conversation/%bad"),
    ).not.toThrow();
  });

  it("treats only Home and its aliases as the meeting page", () => {
    for (const path of [
      "/",
      "/home",
      "/home/",
      "/video",
      "/file",
      "/setting",
      "/conversation/room",
      "/client/peer/sync",
    ])
      expect(isHomePath(path)).toBe(true);
    for (const path of ["/home/other"])
      expect(isHomePath(path)).toBe(false);
  });
});
