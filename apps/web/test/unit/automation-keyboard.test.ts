import { describe, expect, it } from "vitest";
import {
  parseCall,
  type KeyArguments,
  type TextArguments,
} from "@weblink/automation";

describe("automation keyboard contract", () => {
  it("accepts named keys, ordered chords, held input and bounded timing", () => {
    const calls: KeyArguments[] = [
      { target: "local", action: "press", key: "Enter" },
      { target: "peer", action: "down", key: "ShiftLeft" },
      { target: "peer", action: "up", key: "ShiftLeft" },
      {
        target: "local",
        action: "press",
        key: "ArrowRight",
        repeat: 100,
        holdMs: 100,
        intervalMs: 0,
      },
      {
        target: "local",
        action: "chord",
        keys: ["ControlRight", "ShiftLeft", "KeyS"],
        holdMs: 50,
        repeat: 2,
        intervalMs: 120,
      },
      {
        target: "local",
        action: "press",
        key: "NumpadEnter",
      },
    ];
    for (const args of calls) {
      expect(
        parseCall({ name: "control.key", arguments: args })
          .scope,
      ).toBe("input.control");
    }
  });
  it("rejects ambiguous, overlapping, obsolete and unbounded key arguments", () => {
    const invalid = [
      { scanCode: 30 },
      { action: "press", key: "Ctrl+C" },
      { action: "press", key: "a" },
      { action: "press", key: "PrintScreen" },
      { action: "press", key: "Pause" },
      { action: "press", key: "Enter", extended: true },
      { action: "down", key: "KeyA", holdMs: 50 },
      { action: "up", key: "KeyA", repeat: 2 },
      { action: "press", key: "Enter", keys: ["Enter"] },
      { action: "chord", keys: [] },
      { action: "chord", keys: ["KeyA"] },
      {
        action: "chord",
        keys: ["ControlLeft", "KeyA", "ControlLeft"],
      },
      {
        action: "chord",
        keys: [
          "KeyA",
          "KeyB",
          "KeyC",
          "KeyD",
          "KeyE",
          "KeyF",
          "KeyG",
          "KeyH",
          "KeyI",
        ],
      },
      { action: "press", key: "Enter", repeat: 0 },
      { action: "press", key: "Enter", repeat: 101 },
      { action: "press", key: "Enter", holdMs: 0 },
      { action: "press", key: "Enter", holdMs: 2001 },
      { action: "press", key: "Enter", intervalMs: -1 },
      { action: "press", key: "Enter", intervalMs: 1001 },
    ];
    for (const args of invalid) {
      expect(() =>
        parseCall({
          name: "control.key",
          arguments: { target: "local", ...args },
        }),
      ).toThrow();
    }
  });
  it("counts Unicode characters and bounds text pacing", () => {
    const args: TextArguments = {
      target: "local",
      text: "中😀",
      intervalMs: 50,
    };
    expect(
      parseCall({
        name: "control.text",
        arguments: { ...args },
      }).scope,
    ).toBe("input.control");
    expect(() =>
      parseCall({
        name: "control.text",
        arguments: {
          target: "local",
          text: "😀".repeat(4096),
        },
      }),
    ).not.toThrow();
    for (const text of ["", "😀".repeat(4097)]) {
      expect(() =>
        parseCall({
          name: "control.text",
          arguments: { target: "local", text },
        }),
      ).toThrow();
    }
    for (const intervalMs of [-1, 1001, 0.5]) {
      expect(() =>
        parseCall({
          name: "control.text",
          arguments: { ...args, intervalMs },
        }),
      ).toThrow();
    }
  });
});
