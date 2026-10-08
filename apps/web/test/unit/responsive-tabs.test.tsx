// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { ResponsiveTabs } from "@/components/ui/responsive-tabs";
import {
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

const initialWidth = window.innerWidth;
afterEach(() => {
  cleanup();
  window.innerWidth = initialWidth;
  fireEvent(window, new Event("resize"));
  vi.restoreAllMocks();
});

it("updates keyboard navigation without remounting the selected panel when resizing", async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.innerWidth = 1200;
  fireEvent(window, new Event("resize"));
  render(() => (
    <ResponsiveTabs defaultValue="general">
      <TabsList aria-label="Preferences">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="permissions">
          Berechtigungseinstellungen
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        General options
      </TabsContent>
      <TabsContent value="permissions">
        <input aria-label="Draft" />
      </TabsContent>
    </ResponsiveTabs>
  ));
  const list = screen.getByRole("tablist");
  expect(list).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
  screen.getByRole("tab", { name: "General" }).focus();
  await userEvent.keyboard("{ArrowDown}");
  const permissions = screen.getByRole("tab", {
    name: "Berechtigungseinstellungen",
  });
  expect(permissions).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const draft = screen.getByRole("textbox", {
    name: "Draft",
  });
  await userEvent.type(draft, "keep this value");

  window.innerWidth = 390;
  fireEvent(window, new Event("resize"));
  await waitFor(() =>
    expect(list).toHaveAttribute(
      "aria-orientation",
      "horizontal",
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "Draft" }),
  ).toBe(draft);
  expect(draft).toHaveValue("keep this value");
  expect(permissions).toHaveAttribute(
    "aria-selected",
    "true",
  );

  permissions.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(
    screen.getByRole("tab", { name: "General" }),
  ).toHaveAttribute("aria-selected", "true");
});
