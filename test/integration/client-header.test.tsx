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
    "provides working navigation and settings actions in %s",
    (view, destination, label) => {
      const { container } = renderHeader(view);
      const header = container.querySelector("header")!;
      expect(header).toHaveAttribute(
        "data-slot",
        "client-header",
      );
      const back = screen.getByLabelText("404.home");
      expect(back).toHaveAttribute("href", "/");
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
          : "/?panel=files&member=b",
      );
      const settings = screen.getByRole("button", {
        name: "client.config.open",
      });
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

  it("opens the file tab with the current private peer selected", async () => {
    const { history } = renderHeader("chat");
    fireEvent.click(
      screen.getByLabelText("client.sync.title"),
    );
    await waitFor(() =>
      expect(history.get()).toBe("/?panel=files&member=b"),
    );
  });

  it("keeps actions available without a connected client and updates the displayed name", () => {
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
    expect(heading).toHaveTextContent(name);
  });
});
