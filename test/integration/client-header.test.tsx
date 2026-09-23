import { conversationHref } from "@/libs/application/home-navigation";
import { directConversationId } from "@/libs/domain/conversation";
import { appState } from "@/libs/state/app-state";
// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
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
import {
  MemoryRouter,
  Route,
  createMemoryHistory,
  useParams,
} from "@solidjs/router";
import { createSignal, type JSX } from "solid-js";
import { ClientHeader } from "@/routes/client/[id]/components/client-header";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import type { Client } from "@/libs/domain/client";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/dialogs/client-info-dialog", () => ({
  default: vi.fn(),
}));
vi.mock("@/components/icons", () => {
  const icon =
    (name: string) =>
    (props: JSX.SvgSVGAttributes<SVGSVGElement>) => (
      <svg {...props} data-icon={name} />
    );
  return {
    IconChatBubble: icon("chat"),
    IconChevronLeft: icon("back"),
    IconFolderMatch: icon("sync"),
    IconSettings: icon("settings"),
  };
});

const openClientInfo = vi.fn();
const peer: Client = {
  clientId: "b",
  name: "Peer",
  avatar: null,
};

function renderHeader(
  view: "chat" | "sync",
  initialClient: Client | undefined = peer,
) {
  const history = createMemoryHistory();
  history.set({ value: `/client/b/${view}` });
  const [client, setClient] = createSignal<
    Client | undefined
  >(initialClient);
  const result = render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/client/:id/:view"
        component={() => {
          const params = useParams<{
            id: string;
            view: string;
          }>();
          return (
            <ClientHeader
              clientId={params.id}
              client={client()}
              view={
                params.view === "chat" ? "chat" : "sync"
              }
            />
          );
        }}
      />
    </MemoryRouter>
  ));
  return { ...result, history, setClient };
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  openClientInfo.mockReset();
  openClientInfo.mockResolvedValue({ cancel: true });
  vi.mocked(clientInfoDialog).mockReturnValue({
    open: openClientInfo,
    close: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared client header", () => {
  it.each([
    ["chat", "sync", "client.sync.title"],
    ["sync", "chat", "client.sync.menu.chat"],
  ] as const)(
    "uses the same layout and working actions in %s",
    (view, destination, label) => {
      const { container } = renderHeader(view);
      const header = container.querySelector("header")!;
      expect(header).toHaveAttribute(
        "data-slot",
        "client-header",
      );
      expect(header).toHaveClass(
        "sticky",
        "shrink-0",
        "gap-2",
        "border-b",
        "p-2",
        "border-border",
        "bg-background/80",
        "backdrop-blur",
        "top-(--mobile-header-height)",
        "md:top-0",
      );
      const back = screen.getByLabelText("404.home");
      expect(back).toHaveAttribute("href", "/");
      expect(back).not.toHaveClass("sm:hidden");
      expect(back).toHaveClass("size-9");
      const link = screen.getByLabelText(label);
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute(
        "href",
        destination === "chat"
          ? conversationHref(
              directConversationId(
                appState.profile.clientId,
                "b",
              ),
            )
          : `/client/b/${destination}`,
      );
      expect(link).toHaveClass("size-9");
      expect(link.querySelector("svg")).toHaveClass(
        "size-6",
      );
      const settings = screen.getByRole("button", {
        name: "client.config.open",
      });
      expect(settings).toHaveClass("size-9");
      expect(settings.querySelector("svg")).toHaveClass(
        "size-6",
      );
      expect(
        header.querySelector(
          "button button, button a, a button",
        ),
      ).toBeNull();
      fireEvent.click(settings);
      expect(openClientInfo).toHaveBeenCalledWith(
        "b",
        "session",
        undefined,
      );
    },
  );

  it("returns from file sync to the selected conversation on Home", async () => {
    const { container, history } = renderHeader("chat");
    const headerClass =
      container.querySelector("header")!.className;
    fireEvent.click(
      screen.getByLabelText("client.sync.title"),
    );
    await waitFor(() =>
      expect(history.get()).toBe("/client/b/sync"),
    );
    expect(
      container.querySelector("header")!.className,
    ).toBe(headerClass);
    fireEvent.click(
      screen.getByLabelText("client.sync.menu.chat"),
    );
    await waitFor(() =>
      expect(history.get()).toBe(
        conversationHref(
          directConversationId(
            appState.profile.clientId,
            "b",
          ),
        ),
      ),
    );
  });

  it("keeps actions available without a connected client and truncates long names", () => {
    const { setClient } = renderHeader("sync");
    setClient(undefined);
    expect(
      screen.getByRole("heading", { name: "b" }),
    ).toBeInTheDocument();
    const settings = screen.getByRole("button", {
      name: "client.config.open",
    });
    expect(settings).toBeEnabled();
    fireEvent.click(settings);
    expect(openClientInfo).toHaveBeenCalledWith(
      "b",
      "session",
      undefined,
    );
    const name = "A very long client display name "
      .repeat(10)
      .trim();
    setClient({ ...peer, name });
    const heading = screen.getByTitle(name);
    expect(heading).toHaveClass("min-w-0", "truncate");
    expect(settings.parentElement).toHaveClass("shrink-0");
  });
});
