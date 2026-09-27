// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getRoomNamespace } from "@/libs/application/room-identity";

const deployment = vi.hoisted(() => ({
  url: "wss://signaling.test/ws",
}));
vi.mock("@/libs/state/app-options", () => ({
  get signalingWebSocketUrl() {
    return deployment.url;
  },
}));

beforeEach(() => {
  deployment.url = "wss://signaling.test/ws";
});

describe("WebSocket room history identity", () => {
  it("keeps the existing WebSocket namespace so existing history remains accessible", () => {
    expect(getRoomNamespace()).toBe(
      "websocket:wss://signaling.test/ws",
    );
  });

  it("ignores credentials, room selection and fragments but retains endpoint routing", () => {
    deployment.url =
      "wss://name:secret@signaling.test/ws?tenant=one&room=alpha&pwd=hash#old";
    const first = getRoomNamespace();
    deployment.url =
      "wss://other:password@signaling.test/ws?tenant=one&room=beta&pwd=other#new";
    expect(getRoomNamespace()).toBe(first);
    expect(first).toBe(
      "websocket:wss://signaling.test/ws?tenant=one",
    );
  });

  it("separates different signaling deployments", () => {
    const first = getRoomNamespace();
    deployment.url = "wss://other-signaling.test/ws";
    expect(getRoomNamespace()).not.toBe(first);
  });

  it("resolves relative endpoints using the page location", () => {
    deployment.url = "/signaling?room=alpha&pwd=secret";
    expect(getRoomNamespace()).toBe(
      `websocket:${new URL("/signaling", window.location.href).href}`,
    );
  });
});
