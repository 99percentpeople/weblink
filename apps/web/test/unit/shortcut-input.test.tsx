// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ShortcutInput } from "@/components/ui/shortcut-input";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(cleanup);

function setup(
  change = vi.fn(async (_value: string) => {}),
) {
  const [value, setValue] = createSignal(
    "ctrl-alt-shift-q",
  );
  render(() => (
    <ShortcutInput
      label="Release shortcut"
      value={value()}
      defaultValue="ctrl-alt-shift-q"
      onChange={async (next) => {
        await change(next);
        setValue(next);
      }}
    />
  ));
  const button = screen.getByLabelText("Release shortcut");
  const record = () => {
    button.focus();
    fireEvent.click(button);
  };
  return { value, change, button, record };
}
it("saves a complete chord on main-key release and resets it", async () => {
  const { value, change, button, record } = setup();
  record();
  fireEvent.keyDown(button, {
    code: "ControlLeft",
    ctrlKey: true,
  });
  fireEvent.keyDown(button, {
    code: "ArrowUp",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(button.textContent).toContain("Ctrl");
  expect(button.textContent).toContain("Shift");
  expect(button.textContent).toContain("↑");
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyUp(button, { code: "ArrowUp" });
  await waitFor(() =>
    expect(value()).toBe("ctrl-shift-arrowup"),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.shortcut_input.reset",
    }),
  );
  await waitFor(() =>
    expect(value()).toBe("ctrl-alt-shift-q"),
  );
});
it("previews modifier presses and releases before a complete chord exists", () => {
  const { button, record, change, value } = setup();
  record();
  fireEvent.keyDown(button, {
    code: "ControlLeft",
    ctrlKey: true,
  });
  expect(button.textContent).toContain("Ctrl");
  expect(button.textContent).not.toContain(
    "setting.shortcut_input.recording",
  );
  fireEvent.keyDown(button, {
    code: "ShiftLeft",
    ctrlKey: true,
    shiftKey: true,
  });
  expect(button.textContent).toContain("Ctrl");
  expect(button.textContent).toContain("Shift");
  fireEvent.keyUp(button, {
    code: "ControlLeft",
    shiftKey: true,
  });
  expect(button.textContent).not.toContain("Ctrl");
  expect(button.textContent).toContain("Shift");
  fireEvent.keyUp(button, { code: "ShiftLeft" });
  expect(button.textContent).toContain(
    "setting.shortcut_input.recording",
  );
  expect(value()).toBe("ctrl-alt-shift-q");
  expect(change).not.toHaveBeenCalled();
});
it("updates the chord when a modifier is added while its main key is held", async () => {
  const { button, record, change, value } = setup();
  record();
  fireEvent.keyDown(button, { code: "KeyY", key: "z" });
  expect(button.textContent).toContain("Z");
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.keyDown(button, {
    code: "ControlLeft",
    key: "Control",
    ctrlKey: true,
  });
  expect(button.textContent).toContain("Ctrl");
  expect(button.textContent).toContain("Z");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyUp(button, {
    code: "KeyY",
    key: "z",
    ctrlKey: true,
  });
  await waitFor(() => expect(value()).toBe("ctrl-z"));
});
it("cancels with Escape or lost focus, keeping the old value and releasing listeners", async () => {
  const { button, record, change } = setup();
  const bubble = vi.fn();
  document.addEventListener("keydown", bubble);
  record();
  fireEvent.keyDown(button, { code: "Escape" });
  expect(bubble).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, {
    code: "KeyQ",
    ctrlKey: true,
  });
  expect(bubble).toHaveBeenCalledOnce();
  record();
  fireEvent.keyDown(button, {
    code: "KeyX",
    ctrlKey: true,
  });
  fireEvent.blur(window);
  fireEvent.keyUp(button, { code: "KeyX" });
  expect(change).not.toHaveBeenCalled();
  document.removeEventListener("keydown", bubble);
});
it("rejects bare keys, repeats and composition without changing preferences", () => {
  const { button, record, change } = setup();
  record();
  for (const event of [
    { code: "KeyA" },
    { code: "KeyX", ctrlKey: true, repeat: true },
    { code: "KeyX", ctrlKey: true, isComposing: true },
  ]) {
    fireEvent.keyDown(button, event);
    fireEvent.keyUp(button, event);
  }
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain(
    "invalid",
  );
});
it("keeps the saved chord and surfaces an asynchronous registration conflict", async () => {
  const { button, value, record } = setup(
    vi.fn(async () => {
      throw new Error("Shortcut in use");
    }),
  );
  record();
  fireEvent.keyDown(button, {
    code: "F8",
    ctrlKey: true,
    altKey: true,
  });
  fireEvent.keyUp(button, { code: "F8" });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Shortcut in use",
    ),
  );
  expect(value()).toBe("ctrl-alt-shift-q");
  expect(button.hasAttribute("disabled")).toBe(false);
});
