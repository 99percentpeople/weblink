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
import { reconcile } from "solid-js/store";
import {
  MemoryRouter,
  Route,
  createMemoryHistory,
} from "@solidjs/router";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import Sync from "@/routes/client/[id]/sync";
import { useAppState } from "@/libs/state/app-state-context";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { FileCatalogService } from "@/libs/application/file-catalog-service";
import { FileCatalogIndex } from "@/libs/application/file-catalog-index";
import {
  P2PProtocol,
  type StorageMessage,
} from "@/libs/domain/protocol";
import {
  FakeRtcTransport,
  flushRtc,
  makeSession,
} from "../support/rtc-transport";

vi.mock("@/i18n", () => ({
  t: (key: string, args?: unknown) =>
    args ? `${key} ${JSON.stringify(args)}` : key,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/components/icons", async (importOriginal) => {
  const icons =
    await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.keys(icons).map((key) => [key, () => <span />]),
  );
});
vi.mock("@/components/dialogs/client-info-dialog", () => ({
  default: vi.fn(),
}));
vi.mock("@/components/dialogs/preview-dialog", () => ({
  createPreviewDialog: () => ({ open: vi.fn() }),
}));
vi.mock(
  "@/components/dialogs/confirm-delete-items-dialog",
  () => ({
    createComfirmDeleteItemsDialog: () => ({
      open: vi.fn(),
    }),
  }),
);
vi.mock("@/components/common/connection-badge", () => ({
  ConnectionBadge: () => <span />,
}));
vi.mock("@/components/icon-file", () => ({
  IconFile: () => <span />,
}));
vi.mock(
  "@/components/data-table/data-table-column-visibility",
  () => ({
    default: () => <button>common.action.view</button>,
  }),
);
vi.mock(
  "@/components/data-table/data-table-column-header",
  () => ({
    DataTableColumnHeader: (props: any) => (
      <button onClick={() => props.column.toggleSorting()}>
        {props.title}
      </button>
    ),
  }),
);

const openClientInfo = vi.fn();
let a: ReturnType<typeof createSide>;
let b: ReturnType<typeof createSide>;

function renderSync(path = "/client/b/sync") {
  const history = createMemoryHistory();
  history.set({ value: path });
  const result = render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/client/:id"
        component={(props) => (
          <>
            {/* Deliberately retain Sync across child routes to test route gating,
                not just the component's unmount cleanup. */}
            <Sync />
            {props.children}
          </>
        )}
      >
        <Route
          path={["/sync", "/sync/child", "/chat"]}
          component={() => null}
        />
      </Route>
    </MemoryRouter>
  ));
  return {
    ...result,
    navigate: (value: string) => history.set({ value }),
  };
}

async function notifyChanged() {
  await b.protocol.notify(b.session, "storage-changed", {});
  await flushRtc();
}
function createSide(client: string, target: string) {
  // Production PeerSession is a class instance, not a Solid-wrapped plain object.
  const session = new (class {
    clientId = client;
    targetClientId = target;
  })() as ReturnType<typeof makeSession>;
  const transport = new FakeRtcTransport();
  const protocol = new P2PProtocol(transport);
  const index = new FileCatalogIndex();
  let allowed = true;
  const catalog = new FileCatalogService({
    protocol,
    index,
    getSessions: () => [session],
    isReady: () => true,
    canList: () => allowed,
    onSessionClosed: (handler) =>
      transport.onSessionClosed(handler),
  });
  catalog.syncSharing();
  return {
    session,
    transport,
    protocol,
    index,
    catalog,
    share(value: boolean) {
      allowed = value;
      catalog.syncSharing();
    },
    dispose() {
      catalog.dispose();
      protocol.dispose();
    },
  };
}
const sentQueries = () =>
  a.transport.sendCalls
    .map((call) => call.message)
    .filter(
      (message) => message.type === "request-storage",
    );

beforeEach(() => {
  sessionStorage.clear();
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
  setAppState(reconcile(createInitialAppState()));
  a = createSide("a", "b");
  b = createSide("b", "a");
  a.transport.sendImpl = (_session, message) => {
    void b.transport.emit(b.session, message);
  };
  b.transport.sendImpl = (_session, message) => {
    void a.transport.emit(a.session, message);
  };
  for (let i = 0; i < 61; i++) {
    const name = `file-${String(i).padStart(2, "0")}.txt`;
    b.index.update(name, {
      id: name,
      fileName: name,
      fileSize: i + 1,
      chunkSize: 4,
      isComplete: true,
    });
  }
  setAppState("session", "sessions", "b", a.session);
  setAppState("session", "clientViewData", "b", {
    clientId: "b",
    name: "Peer",
    avatar: null,
    createdAt: 1,
    onlineStatus: "online",
    messageChannel: true,
  });
  setAppState("message", "clients", [
    { clientId: "b", name: "Peer", avatar: null },
  ]);
  vi.mocked(useAppState).mockReturnValue({
    catalog: a.catalog,
    requestFile: vi.fn(),
  } as unknown as ReturnType<typeof useAppState>);
});
afterEach(() => {
  cleanup();
  a.dispose();
  b.dispose();
  vi.unstubAllGlobals();
});

describe("Sync controlled TanStack directory table", () => {
  it("fetches pages and searches the entire remote directory, resetting the page", async () => {
    renderSync();
    await screen.findByText("file-00.txt");
    expect(screen.queryByText("file-60.txt")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.pagination.next",
      }),
    );
    await screen.findByText("file-25.txt");
    expect(sentQueries().at(-1)).toMatchObject({
      pageIndex: 1,
      pageSize: 25,
    });
    fireEvent.input(screen.getByRole("searchbox"), {
      target: { value: "file-60" },
    });
    await screen.findByText("file-60.txt");
    expect(sentQueries().at(-1)).toMatchObject({
      pageIndex: 0,
      search: "file-60",
    });
    expect(screen.queryByText("file-25.txt")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "common.pagination.next",
      }),
    ).toBeDisabled();
  });

  it("refreshes the current page after a notification, preserving sort and page size", async () => {
    renderSync();
    await screen.findByText("file-00.txt");
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "10" },
    });
    await waitFor(() =>
      expect(sentQueries().at(-1)).toMatchObject({
        pageSize: 10,
        pageIndex: 0,
      }),
    );
    await screen.findByText("file-00.txt");
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.file_table.columns.size",
      }),
    );
    await screen.findByText("file-60.txt");
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.pagination.next",
      }),
    );
    await screen.findByText("file-50.txt");
    const previous = sentQueries().length;
    b.index.update("file-00.txt", null);
    await waitFor(() =>
      expect(sentQueries().length).toBeGreaterThan(
        previous,
      ),
    );
    expect(sentQueries().at(-1)).toMatchObject({
      pageIndex: 1,
      pageSize: 10,
      sort: [{ field: "fileSize", desc: true }],
    });
    await screen.findByText("file-50.txt");
  });

  it("clears the directory on sharing disable and reloads on channel recovery", async () => {
    renderSync();
    await screen.findByText("file-00.txt");
    b.share(false);
    await screen.findByText("client.sync.sharing_disabled");
    expect(screen.queryByText("file-00.txt")).toBeNull();
    setAppState(
      "session",
      "clientViewData",
      "b",
      "messageChannel",
      false,
    );
    expect(
      screen.queryByText("client.sync.sharing_disabled"),
    ).toBeNull();
    await screen.findByText(
      "client.sync.disconnected.title",
    );
    expect(screen.queryByRole("table")).toBeNull();
    const previous = sentQueries().length;
    b.share(true);
    await notifyChanged();
    expect(sentQueries()).toHaveLength(previous);
    setAppState(
      "session",
      "clientViewData",
      "b",
      "messageChannel",
      true,
    );
    await screen.findByText("file-00.txt");
    expect(
      screen.queryByText("client.sync.disconnected.title"),
    ).toBeNull();
  });

  it("clears loaded rows when a peer goes offline before its channel closes, then reloads on reconnect", async () => {
    renderSync();
    await screen.findByText("file-00.txt");
    setAppState(
      "session",
      "clientViewData",
      "b",
      "onlineStatus",
      "offline",
    );
    await screen.findByText(
      "client.sync.disconnected.title",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("file-00.txt")).toBeNull();
    const previous = sentQueries().length;
    b.index.update("file-00.txt", null);
    await notifyChanged();
    expect(sentQueries()).toHaveLength(previous);
    setAppState(
      "session",
      "clientViewData",
      "b",
      "onlineStatus",
      "online",
    );
    await screen.findByText("file-01.txt");
    expect(screen.queryByText("file-00.txt")).toBeNull();
    expect(
      screen.queryByText("client.sync.disconnected.title"),
    ).toBeNull();
  });

  it("places refresh next to View and opens client settings from the header", async () => {
    renderSync();
    await screen.findByText("file-00.txt");
    const refresh = screen.getByRole("button", {
      name: "client.sync.menu.refresh",
    });
    const view = screen.getByRole("button", {
      name: "common.action.view",
    });
    const settings = screen.getByRole("button", {
      name: "client.config.open",
    });
    expect(refresh.parentElement).toBe(view.parentElement);
    expect(settings.parentElement).not.toBe(
      view.parentElement,
    );
    const header = settings.closest(
      "[data-slot=client-header]",
    );
    expect(header).toHaveClass(
      "bg-background/80",
      "border-b",
      "p-2",
    );
    expect(header).not.toContainElement(refresh);
    expect(header).toContainElement(
      screen.getByLabelText("client.sync.menu.chat"),
    );
    fireEvent.click(settings);
    expect(openClientInfo).toHaveBeenCalledWith("b");
    const previous = sentQueries().length;
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(sentQueries().length).toBeGreaterThan(
        previous,
      ),
    );
    expect(sentQueries().at(-1)).toMatchObject({
      pageIndex: 0,
      pageSize: 25,
    });
  });

  it.each([
    "channel",
    "status",
    "session",
    "client-view",
  ] as const)(
    "shows an empty state without querying when the %s is unavailable",
    async (missing) => {
      if (missing === "channel")
        setAppState(
          "session",
          "clientViewData",
          "b",
          "messageChannel",
          false,
        );
      else if (missing === "status")
        setAppState(
          "session",
          "clientViewData",
          "b",
          "onlineStatus",
          "offline",
        );
      else if (missing === "session")
        setAppState("session", "sessions", "b", undefined!);
      else
        setAppState(
          "session",
          "clientViewData",
          "b",
          undefined!,
        );
      renderSync();
      await screen.findByText(
        "client.sync.disconnected.title",
      );
      expect(
        screen.getByText(
          "client.sync.disconnected.description",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
      const settings = screen.getByRole("button", {
        name: "client.config.open",
      });
      expect(settings).toBeEnabled();
      fireEvent.click(settings);
      expect(openClientInfo).toHaveBeenCalledWith("b");
      await notifyChanged();
      expect(sentQueries()).toHaveLength(0);
    },
  );

  it.each(["/client/b/chat", "/client/b/sync/child"])(
    "does not query at %s even when Sync stays mounted, then reloads its current page on return",
    async (path) => {
      const { navigate } = renderSync();
      await screen.findByText("file-00.txt");
      fireEvent.input(screen.getByRole("searchbox"), {
        target: { value: "file-" },
      });
      await waitFor(() =>
        expect(sentQueries().at(-1)).toMatchObject({
          search: "file-",
        }),
      );
      await screen.findByText("file-00.txt");
      fireEvent.click(
        screen.getByRole("button", {
          name: "common.pagination.next",
        }),
      );
      await screen.findByText("file-25.txt");
      navigate(path);
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: "client.sync.menu.refresh",
          }),
        ).toBeDisabled(),
      );
      // The test layout retains Sync; it must unsubscribe based on the URL itself.
      expect(
        screen.getByRole("searchbox"),
      ).toBeInTheDocument();
      const previous = sentQueries().length;
      b.index.update("file-00.txt", null);
      await notifyChanged();
      expect(sentQueries()).toHaveLength(previous);
      expect(screen.queryByText("file-25.txt")).toBeNull();
      navigate("/client/b/sync");
      await screen.findByText("file-26.txt");
      expect(sentQueries().at(-1)).toMatchObject({
        pageIndex: 1,
        pageSize: 25,
        search: "file-",
      });
    },
  );

  it("does not subscribe when initially mounted outside sync", async () => {
    const { navigate } = renderSync("/client/b/chat");
    await notifyChanged();
    expect(sentQueries()).toHaveLength(0);
    navigate("/client/b/sync/");
    await screen.findByText("file-00.txt");
    expect(sentQueries().at(-1)).toMatchObject({
      pageIndex: 0,
    });
  });

  it("aborts an in-flight page request on leaving sync and ignores its late response", async () => {
    const { navigate } = renderSync();
    await screen.findByText("file-00.txt");
    let response: StorageMessage | undefined;
    b.transport.sendImpl = (_session, message) => {
      if (message.type === "storage") response = message;
      else void a.transport.emit(a.session, message);
    };
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.sync.menu.refresh",
      }),
    );
    await waitFor(() => expect(response).toBeDefined());
    const request = a.transport.sendCalls.findLast(
      (call) => call.message.type === "request-storage",
    )!;
    navigate("/client/b/chat");
    await waitFor(() =>
      expect(request.options?.signal?.aborted).toBe(true),
    );
    const previous = sentQueries().length;
    await a.transport.emit(a.session, response!);
    await notifyChanged();
    expect(sentQueries()).toHaveLength(previous);
    expect(screen.queryByText("file-00.txt")).toBeNull();
  });
});
