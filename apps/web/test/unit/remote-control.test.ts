import { describe, expect, it, vi } from "vitest";
import fixtures from "../../../../test/fixtures/remote-control-signals.json";
import {
  canRequestControl,
  parseControlSignal,
  type ControlSignal,
} from "@/libs/domain/protocol/remote-control";
import {
  RemoteControlSession,
  type ControlBinding,
} from "@/libs/domain/remote-control/session";

describe("remote control contract", () => {
  for (const fixture of fixtures)
    it(fixture.name, () => {
      const value = parseControlSignal(fixture.json);
      expect(!!value).toBe(fixture.valid);
      if (value)
        expect(
          parseControlSignal(JSON.stringify(value)),
        ).toEqual(value);
    });
  it("does not confuse browser controlling with native input support", () => {
    expect(
      canRequestControl(
        { request: true, host: false },
        { request: false, host: true },
      ),
    ).toBe(true);
    expect(
      canRequestControl({ request: true, host: false }),
    ).toBe(false);
    expect(
      canRequestControl(
        { request: true, host: false },
        { request: true, host: false },
      ),
    ).toBe(false);
  });
});

function setup(persistent = false) {
  let now = 0;
  let nextId = 0;
  const binding: ControlBinding = {
    roomGeneration: "room-1",
    peerGeneration: "peer-1",
    clientId: "client-1",
    target: {
      sourceId: "source-1",
      mediaId: "media-1",
      geometryRevision: "layout-1",
    },
  };
  const port = {
    send: vi.fn<(signal: ControlSignal) => void>(),
    release: vi.fn(),
    suspend: vi.fn(),
    now: () => now,
    id: () => `request-${++nextId}`,
  };
  const session = new RemoteControlSession(
    binding,
    port,
    persistent,
  );
  const request = () =>
    session.request(
      { request: true, host: false },
      { request: true, host: true },
    );
  const grant = (requestId = "request-1", overrides = {}) =>
    session.receive(
      binding,
      JSON.stringify({
        type: "grant",
        requestId,
        target: binding.target,
        grantId: "grant-1",
        leaseMs: 2000,
        ...overrides,
      }),
    );
  return {
    session,
    port,
    binding,
    request,
    grant,
    setTime: (time: number) => (now = time),
  };
}
describe("remote control intent lifecycle", () => {
  it("requires both a current request and the exact target for a grant", () => {
    const { session, request, grant, binding } = setup();
    grant();
    expect(session.state.type).toBe("viewing");
    expect(request()).toBe(true);
    grant("old");
    expect(session.state.type).toBe("requesting");
    for (const key of [
      "sourceId",
      "mediaId",
      "geometryRevision",
    ]) {
      grant("request-1", {
        target: { ...binding.target, [key]: "wrong" },
      });
      expect(session.state.type).toBe("requesting");
    }
    grant();
    expect(session.state.type).toBe("granted");
    expect(request()).toBe(false);
  });
  it("does not accept an identical grant routed from another room or peer generation", () => {
    const { session, request, binding, grant } = setup();
    request();
    for (const key of [
      "roomGeneration",
      "peerGeneration",
      "clientId",
    ]) {
      session.receive(
        { ...binding, [key]: "wrong" },
        JSON.stringify({
          type: "grant",
          requestId: "request-1",
          target: binding.target,
          grantId: "g",
          leaseMs: 2000,
        }),
      );
      expect(session.state.type).toBe("requesting");
    }
    grant();
    expect(session.state.type).toBe("granted");
  });
  it("cancellation and timeout cannot be undone by a late approval", () => {
    const { session, request, grant, port, setTime } =
      setup();
    request();
    session.cancel();
    grant();
    expect(session.state.type).toBe("viewing");
    expect(port.send).toHaveBeenLastCalledWith({
      type: "cancel",
      requestId: "request-1",
    });
    request();
    setTime(30_000);
    grant("request-2");
    expect(session.state.type).toBe("viewing");
    request();
    grant("request-2");
    expect(session.state.type).toBe("requesting");
    grant("request-3");
    expect(session.state.type).toBe("granted");
  });
  it("closes permanently on room leave and releases before notifying the peer", () => {
    const { session, request, grant, port } = setup();
    request();
    grant();
    port.send.mockImplementation(() => {
      expect(port.release).toHaveBeenCalledOnce();
    });
    session.close();
    session.close();
    grant();
    expect(session.state.type).toBe("closed");
    expect(port.release).toHaveBeenCalledOnce();
    expect(request()).toBe(false);
  });
  it("expires a grant without refreshing it from repeated grant messages", () => {
    const { session, request, grant, port, setTime } =
      setup();
    request();
    grant();
    setTime(1500);
    grant();
    setTime(2000);
    session.tick();
    expect(session.state.type).toBe("viewing");
    expect(port.release).toHaveBeenCalledOnce();
    grant();
    expect(session.state.type).toBe("viewing");
  });
  it("fails closed when the transport cannot send", () => {
    const { session, request, port } = setup();
    port.send.mockImplementation(() => {
      throw new Error("channel closed");
    });
    expect(request()).toBe(false);
    expect(session.state.type).toBe("closed");
  });

  it("cannot reopen a session if local release fails", () => {
    const { session, request, grant, port } = setup();
    request();
    grant();
    port.release.mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    expect(() => session.cancel()).toThrow(
      "cleanup failed",
    );
    expect(session.state.type).toBe("closed");
    expect(request()).toBe(false);
  });
  it("copies the binding and state instead of retaining mutable caller objects", () => {
    const { session, request, binding, port } = setup();
    binding.target.sourceId = "replacement";
    request();
    expect(port.send.mock.calls[0][0]).toMatchObject({
      target: { sourceId: "source-1" },
    });
    const state = session.state;
    if (state.type === "requesting") state.deadline = 0;
    session.tick();
    expect(session.state.type).toBe("requesting");
  });
});

it("retains approved persistent sessions through missing heartbeats and never restores explicit revocation", () => {
  const { session, port, request, grant, setTime } =
    setup(true);
  request();
  grant();
  setTime(30_000);
  session.tick();
  session.tick();
  expect(session.state).toMatchObject({
    type: "granted",
    grantId: "grant-1",
  });
  expect(port.suspend).toHaveBeenCalledTimes(1);
  expect(port.release).not.toHaveBeenCalled();
  expect(port.send).toHaveBeenCalledTimes(1);
  session.acknowledge("foreign-grant");
  expect(session.state).toMatchObject({
    deadline: Infinity,
  });
  session.acknowledge("grant-1");
  expect(session.state).toMatchObject({ deadline: 32_000 });
  session.cancel();
  session.acknowledge("grant-1");
  grant();
  expect(session.state.type).toBe("viewing");
  expect(port.release).toHaveBeenCalledTimes(1);
});
