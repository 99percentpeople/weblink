// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import { Spinner } from "@/components/common/spinner";
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverCloseButton,
  PopoverTitle,
} from "@/components/ui/popover";
import { isDictLoaded, t } from "@/i18n";
import { setAppState } from "@/libs/state/app-state";
import type { SupportedLocale } from "@/libs/i18n/locale";

vi.mock("@/options", () => ({ setAppOptions: vi.fn() }));
vi.mock("@/components/icons", () => ({
  IconAddCircle: () => <span />,
  IconCheck: () => <span />,
  IconClose: () => <span />,
}));

async function language(locale: SupportedLocale) {
  setAppState("options", "locale", locale);
  await waitFor(() => expect(isDictLoaded()).toBe(true));
}

beforeEach(async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  await language("en-us");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("updates shared loading text and its accessible name in every language without remounting", async () => {
  render(() => <Spinner />);
  const status = screen.getByRole("status");
  for (const [locale, text] of [
    ["en-us", "Loading..."],
    ["zh-cn", "加载中..."],
    ["zh-tw", "載入中..."],
    ["ja-jp", "読み込み中..."],
    ["ko-kr", "로드 중..."],
    ["es-es", "Cargando..."],
    ["fr-fr", "Chargement..."],
    ["de-de", "Laden..."],
  ] as const) {
    await language(locale);
    expect(screen.getByRole("status", { name: text })).toBe(
      status,
    );
    expect(status).toHaveTextContent(text);
  }
});

it("updates the close action of an already open dialog", async () => {
  render(() => (
    <Dialog open>
      <DialogContent>
        <DialogTitle>
          {t("common.forward_dialog.title")}
        </DialogTitle>
      </DialogContent>
    </Dialog>
  ));
  const close = screen.getByRole("button", {
    name: "Close",
  });
  await language("zh-cn");
  expect(screen.getByRole("button", { name: "关闭" })).toBe(
    close,
  );
  await language("ja-jp");
  expect(
    screen.getByRole("button", {
      name: t("common.action.close"),
    }),
  ).toBe(close);
});

it("translates an open filter's empty state along with the rest of the UI", async () => {
  render(() => (
    <DataTableFacetedFilter
      title={t("tasks.filters.status")}
      options={[]}
    />
  ));
  fireEvent.click(
    screen.getByRole("button", { name: "Status" }),
  );
  const empty = await screen.findByText("No results found");
  await language("zh-cn");
  expect(
    screen.getByText(t("common.no_results_found")),
  ).toBe(empty);
  expect(empty).not.toHaveTextContent("No results found");
});

it("localizes the popover close button instead of exposing the library's default label", async () => {
  await language("fr-fr");
  render(() => (
    <Popover open>
      <PopoverContent>
        <PopoverTitle>{t("tasks.title")}</PopoverTitle>
        <PopoverCloseButton />
      </PopoverContent>
    </Popover>
  ));
  const close = screen.getByRole("button", {
    name: "Fermer",
  });
  await language("de-de");
  expect(
    screen.getByRole("button", {
      name: t("common.action.close"),
    }),
  ).toBe(close);
});
