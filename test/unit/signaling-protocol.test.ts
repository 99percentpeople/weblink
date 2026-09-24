import { describe, expect, it } from "vitest";
import { createClientId } from "@/libs/domain/ids";
import {
  SIGNALING_MAX_CACHED_SIGNALS,
  SIGNALING_MAX_CLIENT_ID_LENGTH,
  SIGNALING_MAX_MESSAGE_BYTES,
  SIGNALING_MAX_PASSWORD_HASH_LENGTH,
  SIGNALING_MAX_ROOM_ID_LENGTH,
  SIGNALING_PROTOCOL_VERSION,
  encodeSignalingEnvelope,
  encodedSignalingMessageSize,
  isSignalingJoinAcknowledgement,
  parseSignalingClientPresence,
  parseSignalingEnvelope,
  parseSignalingPeerMessage,
  parseSignalingPeerOnline,
} from "@/libs/domain/signaling-protocol";

describe("portable signaling contract", () => {
  it("accepts prefixed client IDs alongside legacy UUIDs", () => {
    const clientId = createClientId();
    const targetClientId =
      "a18f574d-63f6-442a-a9cf-cd482e0fc125";

    expect(
      parseSignalingClientPresence({
        clientId,
        createdAt: 42,
      }),
    ).toMatchObject({ clientId });
    expect(
      parseSignalingPeerMessage({
        type: "offer",
        clientId,
        targetClientId,
        data: "opaque",
      }),
    ).toMatchObject({ clientId, targetClientId });
  });

  it("keeps the deployed signaling version and limits explicit", () => {
    expect(SIGNALING_PROTOCOL_VERSION).toBe(2);
    expect(SIGNALING_MAX_CLIENT_ID_LENGTH).toBe(128);
    expect(SIGNALING_MAX_ROOM_ID_LENGTH).toBe(256);
    expect(SIGNALING_MAX_PASSWORD_HASH_LENGTH).toBe(1024);
    expect(SIGNALING_MAX_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(SIGNALING_MAX_CACHED_SIGNALS).toBe(256);
  });

  it("round-trips generic signaling envelopes", () => {
    const signal = {
      type: "joined",
      data: {
        protocolVersion: 2,
        resumed: true,
      },
    };

    expect(
      parseSignalingEnvelope(
        encodeSignalingEnvelope(signal),
      ),
    ).toEqual(signal);
  });

  it("parses and normalizes public client presence", () => {
    expect(
      parseSignalingClientPresence({
        clientId: "  alice  ",
        createdAt: 42,
        rtcProfileVersion: 1,
        resume: true,
        name: "must-not-be-part-of-presence-contract",
      }),
    ).toEqual({
      clientId: "alice",
      createdAt: 42,
      rtcProfileVersion: 1,
      resume: true,
    });

    expect(
      parseSignalingClientPresence({
        clientId: "x".repeat(
          SIGNALING_MAX_CLIENT_ID_LENGTH + 1,
        ),
        createdAt: 1,
      }),
    ).toBeNull();
  });

  it("parses peer-routed signaling without interpreting encrypted payload data", () => {
    const payload = {
      type: "offer",
      clientId: "alice",
      targetClientId: "bob",
      sessionId: "session-1",
      data: "opaque-or-encrypted-payload",
    };

    expect(parseSignalingPeerMessage(payload)).toEqual(
      payload,
    );
  });

  it("parses peer availability without a per-message version", () => {
    const data = {
      clientId: "  alice  ",
      connectionId: "  socket-2  ",
    };
    const parsed = parseSignalingPeerOnline(data);
    expect(parsed).toEqual({
      clientId: "alice",
      connectionId: "socket-2",
    });
    expect(parsed).not.toHaveProperty("version");
    expect(SIGNALING_PROTOCOL_VERSION).toBe(2);
  });

  it.each([
    null,
    [],
    {},
    { clientId: "alice" },
    { clientId: "", connectionId: "socket-2" },
    { clientId: "alice", connectionId: "   " },
    { clientId: "alice", connectionId: 2 },
    {
      clientId: "x".repeat(
        SIGNALING_MAX_CLIENT_ID_LENGTH + 1,
      ),
      connectionId: "socket-2",
    },
    {
      clientId: "alice",
      connectionId: "x".repeat(
        SIGNALING_MAX_CLIENT_ID_LENGTH + 1,
      ),
    },
  ])("rejects invalid peer availability: %j", (data) => {
    expect(parseSignalingPeerOnline(data)).toBeNull();
  });

  it("accepts current-or-newer join acknowledgements", () => {
    expect(
      isSignalingJoinAcknowledgement({
        protocolVersion: SIGNALING_PROTOCOL_VERSION,
        resumed: false,
      }),
    ).toBe(true);
    expect(
      isSignalingJoinAcknowledgement({
        protocolVersion: SIGNALING_PROTOCOL_VERSION - 1,
        resumed: false,
      }),
    ).toBe(false);
    expect(
      isSignalingJoinAcknowledgement({
        protocolVersion: SIGNALING_PROTOCOL_VERSION,
        resumed: "yes",
      }),
    ).toBe(false);
  });

  it("measures UTF-8 encoded signaling size", () => {
    expect(encodedSignalingMessageSize("a")).toBe(1);
    expect(encodedSignalingMessageSize("你")).toBe(3);
  });

  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ data: null }),
  ])("rejects invalid envelopes: %s", (raw) => {
    expect(() => parseSignalingEnvelope(raw)).toThrow();
  });
});
