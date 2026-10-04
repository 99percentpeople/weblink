import { describe, expect, it } from "vitest";
import {
  AutoKeyboard,
  parseTextInputFocus,
  type TextInputFocus,
} from "@/libs/domain/remote-control/auto-keyboard";
const field = (id = "field-a"): TextInputFocus => ({
  type: "editable",
  id,
});
describe("automatic keyboard ownership", () => {
  it("opens for eligible focus, preserves unknown state and closes on confirmed blur", () => {
    const keyboard = new AutoKeyboard();
    expect(
      keyboard.receive(field(), false),
    ).toBeUndefined();
    expect(keyboard.receive(field(), true)).toBe("show");
    expect(
      keyboard.receive({ type: "unknown" }, true),
    ).toBeUndefined();
    expect(keyboard.receive(field(), true)).toBeUndefined();
    expect(keyboard.receive({ type: "none" }, true)).toBe(
      "hide",
    );
    expect(keyboard.receive(field("field-b"), true)).toBe(
      "show",
    );
  });
  it("keeps manual keyboards open and suppresses automatic reopening until a new tap", () => {
    const keyboard = new AutoKeyboard();
    keyboard.manual();
    expect(
      keyboard.receive({ type: "none" }, true),
    ).toBeUndefined();
    keyboard.dismiss();
    for (const focus of [
      field(),
      { type: "unknown" } as const,
      field("field-b"),
    ])
      expect(keyboard.receive(focus, true)).toBeUndefined();
    keyboard.tap();
    expect(keyboard.receive(field("field-b"), true)).toBe(
      "show",
    );
  });
  it("resets staging only for a changed field, including after an unknown sample", () => {
    const keyboard = new AutoKeyboard();
    keyboard.receive(field(), true);
    keyboard.receive({ type: "unknown" }, true);
    expect(keyboard.receive(field("field-b"), true)).toBe(
      "reset",
    );
    expect(
      keyboard.receive(field("field-b"), true),
    ).toBeUndefined();
  });
  it("rejects malformed focus snapshots", () => {
    for (const value of [
      null,
      {},
      { type: "editable" },
      { type: "editable", id: "" },
      { type: "editable", id: 1 },
      { type: "other" },
    ])
      expect(parseTextInputFocus(value)).toBeUndefined();
    expect(parseTextInputFocus(field())).toEqual(field());
    expect(parseTextInputFocus({ type: "none" })).toEqual({
      type: "none",
    });
  });
});
