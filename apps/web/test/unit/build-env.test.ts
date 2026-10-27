// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkBuildEnv,
  checkDesktopSignalingUrl,
} from "../../scripts/check-build-env";

describe("packaged desktop signaling", () => {
  it.each([
    "wss://ws.webl.ink",
    "wss://signal.example/custom?deployment=test",
    "ws://localhost:9000",
    "ws://dev.localhost:9000",
    "ws://127.0.0.1:9000",
    "ws://127.10.0.1:9000",
    "ws://[::1]:9000",
  ])("accepts a secure or loopback endpoint %s", (url) => {
    expect(() =>
      checkDesktopSignalingUrl(url),
    ).not.toThrow();
  });
  it.each([
    "ws://192.168.68.53:9000",
    "ws://signal.example",
    "ws://localhost.example",
    "ws://127.0.0.1.example",
    "ws://[fe80::1]:9000",
  ])(
    "rejects an endpoint blocked by the packaged secure origin: %s",
    (url) => {
      expect(() => checkDesktopSignalingUrl(url)).toThrow(
        "Desktop builds require wss://",
      );
    },
  );
  it.each([
    "",
    "https://signal.example",
    "wss://signal.example/#fragment",
    "wss://user:private-secret@signal.example",
  ])(
    "rejects invalid WebSocket configuration without echoing secrets: %s",
    (url) => {
      expect(() => checkDesktopSignalingUrl(url)).toThrow(
        "without credentials or a fragment",
      );
      try {
        checkDesktopSignalingUrl(url);
      } catch (error) {
        expect((error as Error).message).not.toContain(
          "private-secret",
        );
      }
    },
  );
});

const configured = {
  VITE_WEBSOCKET_URL: "wss://signal.example",
  WEBLINK_STUN_SERVERS:
    "stun:first.example,stun:second.example",
};

describe("CI build environment", () => {
  it.each([
    "https://dev.webl.ink",
    "https://webl.ink",
    "http://localhost:5173",
  ])("accepts the public sharing URL %s", (url) => {
    expect(() =>
      checkBuildEnv({ ...configured, VITE_SHARE_URL: url }),
    ).not.toThrow();
  });

  it.each([
    "dev.webl.ink",
    "tauri://localhost",
    "javascript:alert(1)",
  ])("rejects invalid public sharing URL %s", (url) => {
    expect(() =>
      checkBuildEnv({ ...configured, VITE_SHARE_URL: url }),
    ).toThrow("VITE_SHARE_URL");
  });

  it("requires configured STUN while allowing backend-managed TURN", () => {
    expect(checkBuildEnv(configured)).toEqual({
      stuns: 2,
      turns: 0,
    });
  });

  it("accepts optional static and HMAC TURN endpoints", () => {
    expect(
      checkBuildEnv({
        ...configured,
        VITE_TURN_SERVERS:
          "turn:static.example|user|password|longterm\nturns:hmac.example||secret|hmac",
      }),
    ).toEqual({ stuns: 2, turns: 2 });
  });

  it("rejects the old STUN name instead of building empty defaults", () => {
    expect(() =>
      checkBuildEnv({
        VITE_WEBSOCKET_URL: configured.VITE_WEBSOCKET_URL,
        VITE_STUN_SERVERS: "stun:legacy.example",
      }),
    ).toThrow("WEBLINK_STUN_SERVERS");
  });

  it("rejects removed Cloudflare authentication without disclosing credentials", () => {
    try {
      checkBuildEnv({
        ...configured,
        VITE_TURN_SERVERS:
          "turn:legacy.example|key-id|private-token|cloudflare",
      });
      throw new Error(
        "Expected invalid TURN configuration",
      );
    } catch (error) {
      expect((error as Error).message).toContain(
        "signaling backend",
      );
      expect((error as Error).message).not.toContain(
        "private-token",
      );
    }
  });

  it("rejects missing or non-WebSocket signaling URLs", () => {
    for (const url of [undefined, "https://signal.example"])
      expect(() =>
        checkBuildEnv({
          ...configured,
          VITE_WEBSOCKET_URL: url,
        }),
      ).toThrow("VITE_WEBSOCKET_URL");
  });
});
