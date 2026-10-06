// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import {
  SettingSwitch,
  SettingSelect,
  SettingSlider,
} from "@/components/settings/setting-controls";
import { SettingField } from "@/components/settings/setting-layout";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps switch labels and descriptions associated while disabled state changes", async () => {
  const [disabled, setDisabled] = createSignal(false);
  const [enabled, setEnabled] = createSignal(false);
  render(() => (
    <SettingSwitch
      label="Transfer files"
      description="Applies to the next operation"
      checked={enabled()}
      disabled={disabled()}
      onChange={setEnabled}
    />
  ));
  const control = screen.getByRole("switch", {
    name: "Transfer files",
  });
  expect(control).toHaveAccessibleDescription(
    "Applies to the next operation",
  );
  await userEvent.click(screen.getByText("Transfer files"));
  expect(enabled()).toBe(true);
  setDisabled(true);
  await userEvent.click(screen.getByText("Transfer files"));
  expect(enabled()).toBe(true);
  expect(control).toBeDisabled();
});

it("updates select values, preserves disabled options and links descriptions", async () => {
  const [value, setValue] = createSignal("cache");
  const [ready, setReady] = createSignal(false);
  render(() => (
    <SettingSelect<string>
      modal
      label="Destination"
      description="Files are stored here"
      value={value()}
      options={["cache", "clipboard"]}
      optionDisabled={(option) =>
        option === "clipboard" && !ready()
      }
      optionLabel={(option) =>
        option === "cache" ? "File cache" : "Clipboard"
      }
      onChange={(next) => next && setValue(next)}
    />
  ));
  const control = screen.getByRole("button", {
    name: /Destination/,
  });
  expect(control).toHaveAccessibleDescription(
    "Files are stored here",
  );
  expect(control).toHaveTextContent("File cache");
  await userEvent.click(control);
  expect(
    screen.getByRole("option", { name: "Clipboard" }),
  ).toHaveAttribute("aria-disabled", "true");
  setReady(true);
  await waitFor(() =>
    expect(
      screen.getByRole("option", { name: "Clipboard" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  await userEvent.click(
    screen.getByRole("option", { name: "Clipboard" }),
  );
  expect(value()).toBe("clipboard");
  expect(control).toHaveTextContent("Clipboard");
});

it("gives repeated custom fields unique associations and preserves callbacks", () => {
  const change = vi.fn();
  const input = (label: string) => (
    <SettingField
      label={label}
      description={`${label} help`}
    >
      {(ids) => (
        <input
          id={ids.id}
          aria-labelledby={ids.labelId}
          aria-describedby={ids.descriptionId}
          onChange={change}
        />
      )}
    </SettingField>
  );
  render(() => (
    <>
      {input("First")}
      {input("Second")}
    </>
  ));
  const first = screen.getByRole("textbox", {
    name: "First",
  });
  const second = screen.getByRole("textbox", {
    name: "Second",
  });
  expect(first.id).not.toBe(second.id);
  expect(first).toHaveAccessibleDescription("First help");
  expect(second).toHaveAccessibleDescription("Second help");
  fireEvent.change(first, { target: { value: "edited" } });
  expect(change).toHaveBeenCalledOnce();
});

it("retains keyboard slider input and its accessible description", async () => {
  const [value, setValue] = createSignal([2]);
  render(() => (
    <SettingSlider
      label="Speed"
      description="Pointer movement speed"
      minValue={1}
      maxValue={5}
      step={1}
      value={value()}
      onChange={setValue}
    />
  ));
  const slider = screen
    .getAllByRole("slider", { name: /Speed/ })
    .find((control) => control.tabIndex === 0)!;
  expect(slider).toHaveAccessibleDescription(
    "Pointer movement speed",
  );
  slider.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(value()).toEqual([3]);
});
