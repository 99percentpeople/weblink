import { describe, expect, it } from "vitest";
import { parseSignalingOverride } from "@/libs/domain/signaling-endpoint";
import { resolveStoredAppOptions } from "@/libs/state/stored-app-options";

describe("custom signaling endpoints", () => {
  it("keeps routing information and restores a saved preference", () => {
    const url = "wss://socket.example/proxy/ws?tenant=one";
    expect(
      resolveStoredAppOptions({
        customSignalingUrl: " " + url + " ",
      }).customSignalingUrl,
    ).toBe(url);
    expect(parseSignalingOverride(" ", true)).toBe("");
  });
  it.each([
    "https://socket.example",
    "/socket",
    "wss:///bad",
    "ws://user:pass@localhost",
    "wss://socket.example/ws#part",
    "wss://socket.example/ws?pwd=secret",
    "wss://socket.example/ws?room=other",
  ])("rejects %s", (url) => {
    expect(parseSignalingOverride(url, false)).toBeNull();
    expect(
      resolveStoredAppOptions({ customSignalingUrl: url })
        .customSignalingUrl,
    ).toBe("");
  });
  it("allows LAN ws on HTTP and loopback ws on a secure page", () => {
    expect(
      parseSignalingOverride(
        "ws://192.168.1.11:9000/ws",
        false,
      ),
    ).toBe("ws://192.168.1.11:9000/ws");
    expect(
      parseSignalingOverride(
        "ws://192.168.1.11:9000/ws",
        true,
      ),
    ).toBeNull();
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      expect(
        parseSignalingOverride(
          "ws://" + host + "/ws",
          true,
        ),
      ).toBe("ws://" + host + "/ws");
  });
});
