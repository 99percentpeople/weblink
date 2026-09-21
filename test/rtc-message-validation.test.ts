import { describe, expect, it } from "vitest";
import { createSessionMessage } from "@/libs/core/protocol/messages";
import {
  assertMessagePeer,
  snapshotSessionMessage,
  parseSessionMessage,
  validateSessionMessage,
} from "@/libs/core/protocol/validation";
import { makeSession } from "./helpers/rtc-transport";

const peer = makeSession();
const base = createSessionMessage(
  peer,
  "send-text",
  { data: "hello" },
  { id: "m1", createdAt: 1 },
);
const file = createSessionMessage(peer, "request-file", {
  fid: "f1",
  fileName: "file.bin",
  fileSize: 10,
  chunkSize: 4,
  ranges: [0, [1, 2]],
  resume: false,
});

describe("session message validation", () => {
  it("snapshots nested payloads and prevents mutation of the pending envelope", () => {
    const ranges: [number, number][] = [[0, 2]];
    const message = { ...file, ranges };
    const snapshot = snapshotSessionMessage(message);
    ranges[0][1] = 100;
    expect(snapshot.ranges).toEqual([[0, 2]]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ranges)).toBe(true);
    expect(Object.isFrozen(snapshot.ranges[0])).toBe(true);
  });

  it("parses valid control envelopes and file ranges", () => {
    expect(
      parseSessionMessage(JSON.stringify(base)),
    ).toEqual(base);
    expect(
      parseSessionMessage(JSON.stringify(file)),
    ).toEqual(file);
    expect(
      validateSessionMessage({
        ...file,
        fileSize: 0,
        ranges: [],
      }),
    ).toBeTruthy();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["empty envelope", {}],
    ["unknown type", { ...base, type: "__proto__" }],
    ["empty ID", { ...base, id: "" }],
    ["missing client", { ...base, client: undefined }],
    ["missing target", { ...base, target: undefined }],
    ["bad timestamp", { ...base, createdAt: Infinity }],
    ["negative timestamp", { ...base, createdAt: -1 }],
    ["bad text", { ...base, data: { text: "hello" } }],
    ["bad ACK", { ...base, type: "ack", mode: "anything" }],
    ["bad error", { ...base, type: "error", error: 123 }],
    [
      "bad state",
      { ...base, type: "stream-state", mode: "unknown" },
    ],
    ["missing file ID", { ...file, fid: undefined }],
    [
      "unsafe file size",
      { ...file, fileSize: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ["zero chunk size", { ...file, chunkSize: 0 }],
    ["invalid resume", { ...file, resume: "yes" }],
    ["negative range", { ...file, ranges: [-1] }],
    ["reversed range", { ...file, ranges: [[2, 1]] }],
    ["out of bounds range", { ...file, ranges: [[0, 3]] }],
    ["malformed tuple", { ...file, ranges: [[0, 1, 2]] }],
    ["fractional chunk index", { ...file, ranges: [1.5] }],
    [
      "bad storage array",
      { ...base, type: "storage", data: {} },
    ],
    [
      "bad storage metadata",
      {
        ...base,
        type: "storage",
        data: [{ id: "f", fileName: "f", fileSize: -1 }],
      },
    ],
    [
      "missing profile",
      { ...base, type: "client-profile", version: 1 },
    ],
    [
      "bad profile avatar",
      {
        ...base,
        type: "client-profile",
        version: 1,
        profile: { name: "Alice", avatar: 42 },
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => validateSessionMessage(input)).toThrow(
      /Invalid RTC protocol message/,
    );
  });

  it("rejects malformed JSON and binary control messages", () => {
    expect(() => parseSessionMessage("{")).toThrow(/JSON/);
    expect(() =>
      parseSessionMessage(new ArrayBuffer(1)),
    ).toThrow(/JSON strings/);
  });

  it("validates both directions against the owning session", () => {
    expect(() =>
      assertMessagePeer(base, peer, false),
    ).not.toThrow();
    expect(() =>
      assertMessagePeer(base, makeSession("b", "a"), true),
    ).not.toThrow();
    expect(() =>
      assertMessagePeer(base, peer, true),
    ).toThrow(/owning session/);
  });

  it("does not let payload fields override the session envelope", () => {
    const payload = {
      data: "hello",
      client: "spoofed",
      target: "spoofed",
      id: "bad",
      type: "error",
    };
    const message = createSessionMessage(
      peer,
      "send-text",
      payload,
      { id: "good" },
    );
    expect(message).toMatchObject({
      type: "send-text",
      id: "good",
      client: "a",
      target: "b",
    });
  });
});
