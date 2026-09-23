// @vitest-environment jsdom
import { createSignal } from "solid-js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  screen,
} from "@solidjs/testing-library";
import {
  closeMediaRoute,
  createMediaHashRoute,
  mediaHash,
  openMediaRoute,
  parseMediaHash,
} from "@/components/conversations/media-hash-route";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("media hash routes", () => {
  it("observes router navigation before the browser address is committed", () => {
    history.replaceState(null, "", "/video");
    const [hash, setHash] = createSignal("");
    render(() => {
      const route = createMediaHashRoute(hash);
      return (
        <output>{route()?.messageId ?? "closed"}</output>
      );
    });
    setHash(
      mediaHash({
        conversationId: "room",
        messageId: "router-next",
      }),
    );
    expect(location.hash).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "router-next",
    );
  });

  it.each([
    {
      conversationId: 'room:["https://signal/房间", "a#b"]',
      messageId: "图片/100%?#",
    },
    {
      conversationId: 'direct:["self","peer"]',
      messageId: "message-42",
    },
  ])(
    "round trips stable identities through URL encoding",
    (route) => {
      expect(parseMediaHash(mediaHash(route))).toEqual(
        route,
      );
    },
  );
  it.each([
    "",
    "#section",
    "#/media/a",
    "#/media/a/b/c",
    "#/media//b",
    "#/media/a/%E0%A4%A",
  ])("ignores malformed or unrelated hash %s", (hash) => {
    expect(parseMediaHash(hash)).toBeUndefined();
  });
  it("keeps path, query and router state when publishing and changing a media route", () => {
    history.replaceState(
      { router: "keep" },
      "",
      "/video?room=secret#section",
    );
    const push = vi.spyOn(history, "pushState");
    const route = {
      conversationId: "room",
      messageId: "first",
    };
    openMediaRoute(route);
    expect(location.pathname + location.search).toBe(
      "/video?room=secret",
    );
    expect(history.state.router).toBe("keep");
    expect(parseMediaHash(location.hash)).toEqual(route);
    openMediaRoute({ ...route, messageId: "second" }, true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(parseMediaHash(location.hash)?.messageId).toBe(
      "second",
    );
    const back = vi
      .spyOn(history, "back")
      .mockImplementation(() => {});
    closeMediaRoute();
    expect(back).toHaveBeenCalledOnce();
  });
  it("clears a direct link without navigating away or losing router state", () => {
    history.replaceState(
      { router: "keep" },
      "",
      "/conversation/room?q=1" +
        mediaHash({
          conversationId: "room",
          messageId: "image",
        }),
    );
    const back = vi.spyOn(history, "back");
    closeMediaRoute();
    expect(
      location.pathname + location.search + location.hash,
    ).toBe("/conversation/room?q=1");
    expect(history.state.router).toBe("keep");
    expect(back).not.toHaveBeenCalled();
  });
  it("reads an initial hash and observes programmatic and native navigation", () => {
    history.replaceState(
      null,
      "",
      "/video" +
        mediaHash({
          conversationId: "room",
          messageId: "initial",
        }),
    );
    render(() => {
      const route = createMediaHashRoute();
      return (
        <output>{route()?.messageId ?? "closed"}</output>
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "initial",
    );
    openMediaRoute(
      { conversationId: "room", messageId: "next" },
      true,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "next",
    );
    history.replaceState(null, "", "/video");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "closed",
    );
  });
});
