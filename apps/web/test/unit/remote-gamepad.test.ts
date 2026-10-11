import { describe, expect, it, vi } from "vitest";
import {
  RemoteGamepads,
  gamepadState,
  type GamepadSample,
} from "@/libs/domain/remote-control/gamepad";
import {
  parseInputCapabilities,
  parseGamepadFeedback,
  type RemoteGamepadEvent,
} from "@/libs/domain/protocol/remote-control/input-devices";
import { resolveRemoteGamepadOptions } from "@/libs/domain/remote-control/gamepad-options";

const sample = (index = 0, id = "pad") => ({
  index,
  id,
  connected: true,
  mapping: "standard" as const,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({
    value: 0,
    pressed: false,
    touched: false,
  })),
});
function setup(slots = 4) {
  const events: RemoteGamepadEvent[] = [];
  const failed = vi.fn();
  let id = 0;
  const pads = new RemoteGamepads(
    (event) => {
      events.push(event);
      return true;
    },
    slots,
    () => `connection-${++id}`,
    failed,
  );
  return { pads, events, failed };
}
describe("remote gamepad lifecycle", () => {
  it("preserves current preferences and bounds vibration and dead zone settings", () => {
    expect(
      resolveRemoteGamepadOptions({ enabled: false })
        .enabled,
    ).toBe(false);
    expect(
      resolveRemoteGamepadOptions({ enabled: true })
        .enabled,
    ).toBe(true);
    expect(
      resolveRemoteGamepadOptions({
        vibration: false,
        vibrationStrength: Infinity,
        deadZone: 2,
      }),
    ).toMatchObject({
      vibration: false,
      vibrationStrength: 1,
      deadZone: 0.5,
    });
    expect(
      resolveRemoteGamepadOptions({
        vibrationStrength: -1,
        deadZone: NaN,
      }),
    ).toMatchObject({
      vibrationStrength: 0,
      deadZone: 0.08,
    });
  });
  it("routes rumble by connection identity, scales strength and stops on unplug or failure", () => {
    const { pads, events } = setup();
    const actuator = () => ({
      playEffect: vi.fn().mockResolvedValue("complete"),
      reset: vi.fn().mockResolvedValue("complete"),
    });
    const first = actuator(),
      second = actuator();
    pads.configure(
      resolveRemoteGamepadOptions({
        vibrationStrength: 0.5,
      }),
    );
    pads.sample(
      [
        { ...sample(0), vibrationActuator: first },
        { ...sample(1), vibrationActuator: second },
      ],
      0,
    );
    const feedback = {
      slot: 0,
      id: events[0].id,
      strongMagnitude: 1,
      weakMagnitude: 0.4,
      duration: 300,
    };
    pads.feedback({ ...feedback, id: "old" });
    expect(first.playEffect).not.toHaveBeenCalled();
    pads.feedback(feedback);
    expect(first.playEffect).toHaveBeenCalledWith(
      "dual-rumble",
      {
        duration: 300,
        startDelay: 0,
        strongMagnitude: 0.5,
        weakMagnitude: 0.2,
      },
    );
    expect(second.playEffect).not.toHaveBeenCalled();
    pads.feedback({
      ...feedback,
      strongMagnitude: 0,
      weakMagnitude: 0,
    });
    expect(first.reset).toHaveBeenCalledOnce();
    pads.feedback(feedback);
    pads.disconnect(0);
    expect(first.reset).toHaveBeenCalledTimes(2);
    pads.sample(
      [
        {
          ...sample(0, "replacement"),
          vibrationActuator: first,
        },
      ],
      10,
    );
    pads.feedback(feedback);
    expect(first.playEffect).toHaveBeenCalledTimes(2);
    const next = events.findLast(
      (e) => e.action === "connect",
    )!;
    pads.feedback({ ...feedback, id: next.id });
    pads.status({ id: next.id, slot: 0, mounted: false });
    expect(first.reset).toHaveBeenCalledTimes(3);
  });
  it("updates settings without remounting and stops active feedback immediately", () => {
    const { pads, events } = setup();
    const actuator = {
      playEffect: vi.fn().mockResolvedValue("complete"),
      reset: vi.fn().mockResolvedValue("complete"),
    };
    const pad = {
      ...sample(),
      vibrationActuator: actuator,
      axes: [0.15, 0, 0, 0],
    };
    pads.sample([pad], 0);
    const feedback = {
      slot: 0,
      id: events[0].id,
      strongMagnitude: 1,
      weakMagnitude: 1,
      duration: 300,
    };
    pads.feedback(feedback);
    pads.configure(
      resolveRemoteGamepadOptions({
        vibration: false,
        deadZone: 0.2,
      }),
    );
    expect(actuator.reset).toHaveBeenCalledOnce();
    pads.feedback(feedback);
    expect(actuator.playEffect).toHaveBeenCalledOnce();
    pads.sample([pad], 10);
    expect(events.at(-1)).toMatchObject({
      action: "state",
      state: { axes: [0, 0, 0, 0] },
    });
    expect(
      events.filter((e) => e.action === "connect"),
    ).toHaveLength(1);
    pads.configure(
      resolveRemoteGamepadOptions({ enabled: false }),
    );
    expect(events.at(-1)?.action).toBe("disconnect");
  });
  it("keeps input working when haptics are absent or reject without unhandled promises", async () => {
    const { pads, events } = setup();
    const actuator = {
      playEffect: vi
        .fn()
        .mockRejectedValue(new Error("Unsupported")),
      reset: vi
        .fn()
        .mockRejectedValue(new Error("Disconnected")),
    };
    pads.sample(
      [
        { ...sample(), vibrationActuator: actuator },
        sample(1),
      ],
      0,
    );
    const feedback = {
      slot: 0,
      id: events[0].id,
      strongMagnitude: 1,
      weakMagnitude: 1,
      duration: 300,
    };
    pads.feedback(feedback);
    await Promise.resolve();
    await Promise.resolve();
    pads.feedback(feedback);
    expect(actuator.playEffect).toHaveBeenCalledOnce();
    pads.sample(
      [
        { ...sample(), vibrationActuator: actuator },
        sample(1),
      ],
      100,
    );
    expect(events.at(-1)?.action).toBe("state");
    pads.close();
  });
  it("rejects invalid strengths, identities and unbounded vibration durations", () => {
    const valid = {
      slot: 0,
      id: "pad",
      strongMagnitude: 1,
      weakMagnitude: 0,
      duration: 300,
    };
    expect(parseGamepadFeedback(valid)).toEqual(valid);
    for (const patch of [
      { slot: 4 },
      { id: "bad id" },
      { strongMagnitude: NaN },
      { weakMagnitude: -1 },
      { duration: 501 },
      { duration: 0 },
      { duration: 1.5 },
    ])
      expect(
        parseGamepadFeedback({ ...valid, ...patch }),
      ).toBeUndefined();
  });
  it("mounts lazily, sends changed full state and renews unchanged state", () => {
    const { pads, events } = setup();
    expect(events).toEqual([]);
    const pad = sample();
    pads.sample([pad], 0);
    expect(events.map((e) => e.action)).toEqual([
      "connect",
      "state",
    ]);
    pads.sample([pad], 90);
    expect(events).toHaveLength(2);
    pads.sample([pad], 100);
    expect(events.at(-1)?.action).toBe("state");
    pad.buttons[0] = {
      pressed: true,
      touched: true,
      value: 1,
    };
    pads.sample([pad], 101);
    expect(events.at(-1)).toMatchObject({
      action: "state",
      state: { buttons: 1 },
    });
    pads.close();
    pads.close();
    expect(
      events.filter((e) => e.action === "disconnect"),
    ).toHaveLength(1);
  });
  it("reused browser indexes get new identities and stale failures cannot disable replacements", () => {
    const { pads, events, failed } = setup();
    pads.sample([sample(0, "first")], 0);
    const old = events[0];
    pads.sample([sample(0, "second")], 10);
    expect(events[2]).toMatchObject({
      action: "disconnect",
      id: old.id,
    });
    expect(events[3]).toMatchObject({
      action: "connect",
      slot: 0,
    });
    expect(events[3].id).not.toBe(old.id);
    pads.status({ slot: 0, id: old.id, mounted: false });
    expect(failed).not.toHaveBeenCalled();
    pads.sample([], 20);
    expect(events.at(-1)).toMatchObject({
      action: "disconnect",
      id: events[3].id,
    });
  });
  it("caps device count, skips unknown mappings and retries failed mounts only after reconnection", () => {
    const { pads, events, failed } = setup(1);
    pads.sample(
      [{ ...sample(9), mapping: "" }, sample(3), sample(4)],
      0,
    );
    expect(
      events.filter((e) => e.action === "connect"),
    ).toHaveLength(1);
    const { id, slot } = events[0];
    pads.status({ id, slot, mounted: false });
    pads.status({ id, slot, mounted: false });
    pads.sample([sample(3)], 200);
    expect(events).toHaveLength(2);
    expect(failed).toHaveBeenCalledOnce();
    pads.disconnect(3);
    pads.sample([sample(3)], 210);
    expect(events.at(-2)?.action).toBe("connect");
    expect(events.at(-2)?.id).not.toBe(id);
  });
  it("normalizes analog ranges, dead zone and standard trigger positions", () => {
    const pad = sample();
    pad.axes = [NaN, 2, -2, 0.01];
    pad.buttons[6] = {
      value: 0.5,
      pressed: true,
      touched: true,
    };
    pad.buttons[7] = {
      value: Infinity,
      pressed: false,
      touched: false,
    };
    expect(gamepadState(pad)).toEqual({
      buttons: 64,
      axes: [0, 1, -1, 0],
      triggers: [0.5, 0],
    });
  });
  it("never enables missing, ambiguous or invalid host capabilities", () => {
    const cap = {
      kind: "gamepad",
      availability: "available",
      maxDevices: 4,
    };
    expect(parseInputCapabilities([cap])).toEqual([cap]);
    for (const value of [
      undefined,
      {},
      [cap, cap],
      [{ ...cap, maxDevices: 5 }],
      [{ ...cap, availability: true }],
    ]) {
      expect(parseInputCapabilities(value)).toEqual([]);
    }
  });
});
