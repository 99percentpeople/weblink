import { expect, it } from "vitest";
import {
  advertiseCapabilities,
  CURRENT_PROTOCOL_VERSIONS,
  parseProtocolId,
  ProtocolNegotiation,
  requiredMessageFeatures,
} from "@/libs/domain/protocol/protocol-versions";
import { validCapabilityUpdate } from "@/libs/domain/protocol/capabilities";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { validateSessionMessage } from "@/libs/domain/protocol/validation";

it("selects the highest common implementation and pins it until reconnect", () => {
  const connection = new ProtocolNegotiation();
  const local = [
    "extension/1",
    "extension/3",
    "extension/2",
    "other/1",
  ];
  expect([
    ...connection.select(local, [
      "extension/1",
      "extension/2",
      "extension/4",
      "other/2",
    ]),
  ]).toEqual([["extension", "extension/2"]]);
  // Installing or advertising a new major cannot change an in-flight handler.
  expect([
    ...connection.select(local, [
      "extension/3",
      "extension/2",
    ]),
  ]).toEqual([["extension", "extension/2"]]);
  expect([
    ...connection.select(local, ["extension/3"]),
  ]).toEqual([]);
  expect([
    ...new ProtocolNegotiation().select(local, [
      "extension/3",
    ]),
  ]).toEqual([["extension", "extension/3"]]);
});

it("only registers current implementations and uses versioned wire keys", () => {
  expect(
    new Set(Object.values(CURRENT_PROTOCOL_VERSIONS)),
  ).toEqual(new Set([1]));
  expect(
    advertiseCapabilities({
      messaging: {},
      "acme.board/2": { ink: true },
    }),
  ).toEqual({
    "messaging/1": {},
    "acme.board/2": { ink: true },
  });
  for (const id of [
    "control",
    "control/0",
    "control/01",
    "control/-1",
    "control/9007199254740992",
  ])
    expect(parseProtocolId(id)).toBeUndefined();
});

it("isolates unknown majors and malformed current descriptors from compatible services", () => {
  const local = advertiseCapabilities({
    messaging: {},
    files: { content: true, shared: true },
    control: {
      host: true,
      request: true,
      occupancy: { state: "idle" },
    },
  });
  const remote = {
    "messaging/1": {},
    "files/1": { content: true, shared: true },
    "control/2": { completelyDifferentFutureSchema: true },
    "control/1": { host: "invalid" },
    "unknown/8": { future: true },
  };
  expect(
    validCapabilityUpdate({
      kind: "snapshot",
      generation: "generation",
      revision: 1,
      services: remote,
    }),
  ).toBe(true);
  expect(
    new ProtocolNegotiation().project(local, remote),
  ).toEqual({
    messaging: {},
    files: { content: true, shared: true },
  });
  // Unversioned legacy advertisements never imply support.
  expect(
    new ProtocolNegotiation().project(local, {
      messaging: {},
    }),
  ).toEqual({});
});

it("does not interpret an unknown sync major as today's schema", () => {
  const peer = { clientId: "a", targetClientId: "b" };
  const message = createSessionMessage(
    peer,
    "peer-capabilities",
    { update: { kind: "request-snapshot" } },
  );
  expect(message.version).toBe(1);
  expect(() =>
    validateSessionMessage({
      ...message,
      version: 2,
      update: { futureFormat: true },
    }),
  ).not.toThrow();
  expect(() =>
    validateSessionMessage({
      ...message,
      update: { futureFormat: true },
    }),
  ).toThrow();
});

it("gates each feature independently while allowing bootstrap and pending replies", () => {
  expect(requiredMessageFeatures("send-text")).toEqual([
    "messaging",
  ]);
  expect(requiredMessageFeatures("send-file")).toEqual([
    "files",
  ]);
  expect(requiredMessageFeatures("send-room-file")).toEqual(
    ["room", "files"],
  );
  expect(
    requiredMessageFeatures("remote-clipboard"),
  ).toEqual(["control", "clipboard"]);
  for (const type of [
    "peer-capabilities",
    "ack",
    "error",
    "storage",
    "file-offer-result",
  ] as const)
    expect(requiredMessageFeatures(type)).toEqual([]);
});

it("keeps paired automation on the existing version-one contract", () => {
  const local = advertiseCapabilities({
    automation: {},
    messaging: {},
  });
  expect(local["automation/1"]).toEqual({});
  expect(
    new ProtocolNegotiation().project(local, {
      "automation/99": {},
      "messaging/1": {},
    }),
  ).toEqual({ messaging: {} });
  expect(
    new ProtocolNegotiation().project(local, {
      "automation/1": {},
    }),
  ).toEqual({ automation: {} });
});
