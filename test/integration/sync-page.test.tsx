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
  within,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import {
  MemoryRouter,
  Route,
  createMemoryHistory,
} from "@solidjs/router";
import { SharedFilesPanel } from "@/components/files/shared-files-panel";
import Sync from "@/routes/client/[id]/sync";
import { useAppState } from "@/libs/state/app-state-context";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { FileCatalogService } from "@/libs/application/file-catalog-service";
import type { SharedFileTask } from "@/libs/application/task-service";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
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

const { previewOpen } = vi.hoisted(() => ({
  previewOpen: vi.fn(async (_file: File) => {}),
}));

vi.mock("@/i18n", () => ({
  t: (key: string, args?: unknown) =>
    args ? `${key} ${JSON.stringify(args)}` : key,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/components/dialogs/preview-dialog", () => ({
  createPreviewDialog: () => ({ open: previewOpen }),
}));
vi.mock("@/components/files/file-picker-dialog", () => ({
  default: () => <div>picker</div>,
}));
vi.mock("@/components/files/file-browser", () => ({
  FileBrowser: () => <div>local library</div>,
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: () => <span />,
}));
let a: ReturnType<typeof side>, b: ReturnType<typeof side>;
const download = vi.fn(async () => {});
const [downloadProgress, setDownloadProgress] =
  createSignal<SharedFileTask>();
const downloadTask = (peer: string, id: string) =>
  peer === "b" && id === "file-00.txt"
    ? downloadProgress()
    : undefined;
let supported = true;
function side(client: string, target: string) {
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
const queries = () =>
  a.transport.sendCalls
    .map((call) => call.message)
    .filter(
      (message) => message.type === "request-storage",
    );
function mount(member?: string) {
  const [selected, setSelected] = createSignal(member);
  const [browsing, setBrowsing] = createSignal(!member);
  const [split, setSplit] = createSignal(false);
  const select = (id: string) => {
    setSelected(id);
    setBrowsing(false);
  };
  const [active, setActive] = createSignal(true);
  const result = render(() => (
    <SharedFilesPanel
      split={split()}
      active={active()}
      member={selected()}
      browsing={browsing()}
      onBack={() => setBrowsing(true)}
      onSelect={select}
    />
  ));
  return { ...result, select, setActive, setSplit };
}
beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:preview");
      static revokeObjectURL = vi.fn();
    },
  );
  setAppState(reconcile(createInitialAppState()));
  a = side("a", "b");
  b = side("b", "a");
  supported = true;
  download.mockReset().mockResolvedValue(undefined);
  previewOpen.mockClear();
  setDownloadProgress(undefined);
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
      isShared: true,
      sharedReference: true,
      fingerprint: {
        version: 1,
        algorithm: "blake3-256",
        digest: i.toString(16).padStart(64, "0"),
        size: i + 1,
      },
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
  vi.mocked(useAppState).mockReturnValue({
    catalog: a.catalog,
    sharedFiles: { download, downloadTask },
    supportsSharedFiles: () => supported,
  } as unknown as ReturnType<typeof useAppState>);
});
afterEach(() => {
  cleanup();
  a.dispose();
  b.dispose();
  vi.unstubAllGlobals();
});

describe("sidebar shared directory", () => {
  const cacheFirstFile = (
    file = new File(["a"], "local-alias.txt", {
      type: "text/plain",
    }),
  ) => {
    const info = b.index.query({
      pageIndex: 0,
      pageSize: 50,
    }).items[0];
    setAppState("cache", "cacheInfo", "local-alias", {
      ...info,
      id: "local-alias",
      isComplete: true,
      contentKey: contentKey(info.fingerprint!),
      file,
    });
    return file;
  };
  it("previews existing content without task history, excludes it from bulk gets and allows getting again after deletion", async () => {
    const file = cacheFirstFile();
    mount("b");
    const title = await screen.findByTitle("file-00.txt");
    const row = within(title.closest("li")!);
    expect(
      row.queryByText("shared_files.acquired"),
    ).toBeNull();
    expect(row.queryByRole("progressbar")).toBeNull();
    fireEvent.click(
      row.getByRole("button", { name: /file-00.txt/ }),
    );
    expect(previewOpen).toHaveBeenCalledOnce();
    expect(previewOpen).toHaveBeenCalledWith(file);
    expect(download).not.toHaveBeenCalled();
    expect(
      row.queryByRole("button", {
        name: "shared_files.get",
      }),
    ).toBeNull();
    expect(row.getByRole("checkbox")).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "shared_files.select_all",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: 'shared_files.get_count {"count":49}',
      }),
    );
    expect(download).toHaveBeenCalledTimes(49);
    expect(
      download.mock.calls.some(
        (call) =>
          (call as unknown as [string, { id: string }])[1]
            .id === "file-00.txt",
      ),
    ).toBe(false);
    setAppState("cache", "cacheInfo", reconcile({}));
    expect(
      row.getByRole("button", { name: /file-00.txt/ }),
    ).toBeDisabled();
    fireEvent.click(
      row.getByRole("button", { name: "shared_files.get" }),
    );
    expect(download).toHaveBeenCalledTimes(50);
  });
  it("uses local image bytes for a thumbnail and preview, and releases the thumbnail after deletion", async () => {
    const info = b.index.query({
      pageIndex: 0,
      pageSize: 50,
    }).items[0];
    b.index.update(info.id, {
      ...info,
      fileName: "file-00.png",
      mimetype: "image/png",
      isComplete: true,
      isShared: true,
      sharedReference: true,
    });
    const file = cacheFirstFile(
      new File(["a"], "local-image.png", {
        type: "image/png",
      }),
    );
    mount("b");
    const title = await screen.findByTitle("file-00.png");
    const row = within(title.closest("li")!);
    await waitFor(() =>
      expect(URL.createObjectURL).toHaveBeenCalledWith(
        file,
      ),
    );
    expect(row.getByAltText("")).toHaveAttribute(
      "src",
      "blob:preview",
    );
    fireEvent.click(
      row.getByRole("button", { name: /file-00.png/ }),
    );
    expect(previewOpen).toHaveBeenCalledOnce();
    expect(previewOpen).toHaveBeenCalledWith(file);
    expect(download).not.toHaveBeenCalled();
    setAppState("cache", "cacheInfo", reconcile({}));
    expect(row.queryByAltText("")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:preview",
    );
  });
  it("selects a member before querying and returns to the member list", async () => {
    const view = mount();
    expect(queries()).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Peer" }),
    );
    await screen.findByTitle("file-00.txt");
    expect(queries().at(-1)).toMatchObject({
      pageIndex: 0,
      pageSize: 50,
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "shared_files.back",
      }),
    );
    const member = await screen.findByRole("button", {
      name: "Peer",
    });
    expect(member.getAttribute("aria-pressed")).toBe(
      "true",
    );
    const count = queries().length;
    await b.protocol.notify(
      b.session,
      "storage-changed",
      {},
    );
    await flushRtc();
    expect(queries()).toHaveLength(count);
    view.setSplit(true);
    await screen.findByTitle("file-00.txt");
    expect(queries().length).toBeGreaterThan(count);
  });
  it("puts the local file chooser in the shared-file header", () => {
    setAppState("profile", "clientId", "a");
    mount("a");
    const chooser = screen.getByRole("button", {
      name: "shared_files.add",
    });
    expect(
      chooser.closest("header")?.textContent,
    ).toContain("shared_files.mine");
    expect(
      screen.queryByRole("button", {
        name: "shared_files.choose",
      }),
    ).toBeNull();
    expect(queries()).toHaveLength(0);
  });
  it("paginates, searches before slicing, sorts and refreshes the current query", async () => {
    mount("b");
    await screen.findByTitle("file-00.txt");
    expect(screen.queryByTitle("file-60.txt")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "shared_files.next",
      }),
    );
    await screen.findByTitle("file-60.txt");
    fireEvent.input(screen.getByRole("searchbox"), {
      target: { value: "file-60" },
    });
    await waitFor(() =>
      expect(queries().at(-1)).toMatchObject({
        search: "file-60",
        pageIndex: 0,
      }),
    );
    await screen.findByTitle("file-60.txt");
    const user = userEvent.setup();
    await user.click(
      screen.getByLabelText("file_library.sort"),
    );
    await user.click(
      await screen.findByRole("option", {
        name: "file_library.sort_size",
      }),
    );
    await waitFor(() =>
      expect(queries().at(-1)?.sort).toEqual([
        { field: "fileSize", desc: false },
      ]),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "shared_files.refresh",
      }),
    );
    await waitFor(() =>
      expect(queries().at(-1)).toMatchObject({
        pageSize: 50,
        search: "file-60",
      }),
    );
    await user.click(
      screen.getByLabelText("shared_files.page_size"),
    );
    await user.click(
      await screen.findByRole("option", { name: "100" }),
    );
    await waitFor(() =>
      expect(queries().at(-1)).toMatchObject({
        pageSize: 100,
        pageIndex: 0,
      }),
    );
  });
  it("shows task progress in the file row, controls pause/resume and restores progress after reopening", async () => {
    const pause = vi.fn(() =>
      setDownloadProgress((task) => ({
        ...task!,
        status: "paused" as const,
        canPause: false,
      })),
    );
    const resume = vi.fn(async () => {
      setDownloadProgress((task) => ({
        ...task!,
        status: "running",
        canPause: true,
      }));
    });
    download.mockImplementationOnce(async () => {
      setDownloadProgress({
        id: "task",
        fileId: "local-file",
        peerId: "b",
        kind: "file-receive",
        shared: true,
        fileName: "file-00.txt",
        total: 100,
        bytes: 0,
        createdAt: 1,
        status: "waiting",
        canPause: true,
        canResume: true,
        pause,
        resume,
        cancel: vi.fn(async () => {}),
      });
    });
    const view = mount("b");
    const title = await screen.findByTitle("file-00.txt");
    fireEvent.click(
      within(title.closest("li")!).getByRole("button", {
        name: "shared_files.get",
      }),
    );
    // Waiting must not revive the old 25% indeterminate download arc.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen.getByRole("button", { name: "tasks.pause" }),
    ).toBeDefined();
    setDownloadProgress((task) => ({
      ...task!,
      status: "running",
      bytes: 0,
    }));
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    setDownloadProgress((task) => ({
      ...task!,
      status: "running",
      bytes: 25,
    }));
    expect(
      screen
        .getByRole("progressbar")
        .getAttribute("aria-valuenow"),
    ).toBe("25");
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.pause" }),
    );
    expect(pause).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "tasks.resume" }),
    );
    expect(resume).toHaveBeenCalledOnce();
    view.setActive(false);
    view.setActive(true);
    await screen.findByTitle("file-00.txt");
    expect(
      screen
        .getByRole("progressbar")
        .getAttribute("aria-valuenow"),
    ).toBe("25");
    expect(download).toHaveBeenCalledOnce();
    const file = cacheFirstFile();
    setDownloadProgress((task) => ({
      ...task!,
      status: "completed",
      bytes: 100,
      canPause: false,
    }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen.queryByText("tasks.status.completed"),
    ).toBeNull();
    const completed = within(
      screen.getByTitle("file-00.txt").closest("li")!,
    );
    fireEvent.click(
      completed.getByRole("button", {
        name: /file-00.txt/,
      }),
    );
    expect(previewOpen).toHaveBeenCalledOnce();
    expect(previewOpen).toHaveBeenCalledWith(file);
    expect(download).toHaveBeenCalledOnce();
    view.setActive(false);
    view.setActive(true);
    await screen.findByTitle("file-00.txt");
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /file-00.txt/ }),
    );
    expect(previewOpen).toHaveBeenCalledTimes(2);
  });
  it.each(["manual", "remote"])(
    "keeps rows and selections mounted during a %s refresh and updates them in place",
    async (trigger) => {
      mount("b");
      const title = await screen.findByTitle("file-01.txt");
      const row = title.closest("li")!;
      const checkbox = within(row).getByRole("checkbox");
      fireEvent.click(checkbox);
      let late: StorageMessage | undefined;
      b.transport.sendImpl = (_session, message) => {
        if (message.type === "storage") late = message;
        else void a.transport.emit(a.session, message);
      };
      if (trigger === "manual") {
        fireEvent.click(
          screen.getByRole("button", {
            name: "shared_files.refresh",
          }),
        );
      } else {
        const info = b.index.query({
          pageIndex: 0,
          pageSize: 50,
        }).items[1];
        b.index.update(info.id, {
          ...info,
          fileName: "file-01-renamed.txt",
          isComplete: true,
          isShared: true,
          sharedReference: true,
        });
      }
      await waitFor(() => expect(late).toBeDefined());
      expect(
        screen.getByTitle("file-01.txt").closest("li"),
      ).toBe(row);
      expect(checkbox).toBeChecked();
      expect(
        within(row).getByRole("button", {
          name: "shared_files.get",
        }),
      ).toBeDisabled();
      expect(
        screen.queryByText("shared_files.loading"),
      ).toBeNull();
      b.transport.sendImpl = (_session, message) => {
        void a.transport.emit(a.session, message);
      };
      await a.transport.emit(a.session, late!);
      await waitFor(() =>
        expect(
          within(row).getByRole("button", {
            name: "shared_files.get",
          }),
        ).not.toBeDisabled(),
      );
      expect(
        screen
          .getByTitle(
            trigger === "manual"
              ? "file-01.txt"
              : "file-01-renamed.txt",
          )
          .closest("li"),
      ).toBe(row);
      expect(within(row).getByRole("checkbox")).toBe(
        checkbox,
      );
      expect(checkbox).toBeChecked();
    },
  );
  it("keeps the previous page on refresh failure and enables downloads again after retry", async () => {
    mount("b");
    const title = await screen.findByTitle("file-00.txt");
    const row = title.closest("li")!;
    vi.spyOn(a.protocol, "call").mockRejectedValueOnce(
      new Error("refresh failed"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "shared_files.refresh",
      }),
    );
    await screen.findByText("errors.file_list_failed");
    expect(
      screen.getByTitle("file-00.txt").closest("li"),
    ).toBe(row);
    expect(
      within(row).getByRole("button", {
        name: "shared_files.get",
      }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "shared_files.refresh",
      }),
    );
    await waitFor(() =>
      expect(
        within(row).getByRole("button", {
          name: "shared_files.get",
        }),
      ).not.toBeDisabled(),
    );
    expect(
      screen.queryByText("errors.file_list_failed"),
    ).toBeNull();
  });
  it.each(["running", "paused"] as const)(
    "returns a cancelled %s file to its initial row state, including after reopening",
    async (status) => {
      const view = mount("b");
      const title = await screen.findByTitle("file-00.txt");
      const element = title.closest("li")!;
      const initialText = element.textContent;
      const row = within(element);
      const cancel = vi.fn(async () => {
        setDownloadProgress((task) => ({
          ...task!,
          status: "cancelled",
          canPause: false,
          canResume: false,
        }));
      });
      setDownloadProgress({
        id: "task",
        fileId: "local-file",
        peerId: "b",
        kind: "file-receive",
        shared: true,
        fileName: "file-00.txt",
        total: 100,
        bytes: 25,
        createdAt: 1,
        status,
        canPause: status === "running",
        canResume: true,
        pause: vi.fn(),
        resume: vi.fn(async () => {}),
        cancel,
      });
      expect(row.getByRole("progressbar")).toBeDefined();
      fireEvent.click(
        row.getByRole("button", {
          name: "common.action.cancel",
        }),
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(element.textContent).toBe(initialText);
      expect(row.queryByRole("progressbar")).toBeNull();
      expect(
        row.queryByRole("button", { name: "tasks.resume" }),
      ).toBeNull();
      expect(
        row.queryByRole("button", {
          name: "common.action.cancel",
        }),
      ).toBeNull();
      expect(row.getByRole("checkbox")).not.toBeDisabled();
      view.setActive(false);
      view.setActive(true);
      const reopened = (
        await screen.findByTitle("file-00.txt")
      ).closest("li")!;
      expect(reopened.textContent).toBe(initialText);
      fireEvent.click(
        within(reopened).getByRole("button", {
          name: "shared_files.get",
        }),
      );
      expect(download).toHaveBeenCalledOnce();
    },
  );
  it("gets selected files through the independent service", async () => {
    mount("b");
    await screen.findByTitle("file-00.txt");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "shared_files.select_all",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /shared_files.get_count/,
      }),
    );
    expect(download).toHaveBeenCalledTimes(50);
    expect(download.mock.calls[0]).toMatchObject([
      "b",
      { id: "file-00.txt" },
    ]);
  });
  it("distinguishes unsupported, disabled and disconnected directories and reloads on reconnect", async () => {
    const view = mount("b");
    await screen.findByTitle("file-00.txt");
    b.share(false);
    await screen.findByText("shared_files.disabled");
    expect(screen.queryByTitle("file-00.txt")).toBeNull();
    setAppState(
      "session",
      "clientViewData",
      "b",
      "onlineStatus",
      "offline",
    );
    await screen.findByText("shared_files.disconnected");
    b.share(true);
    setAppState(
      "session",
      "clientViewData",
      "b",
      "onlineStatus",
      "online",
    );
    await screen.findByTitle("file-00.txt");
    supported = false;
    view.setActive(false);
    view.setActive(true);
    await screen.findByText("shared_files.unsupported");
  });
  it("cancels hidden requests and discards late pages after switching member", async () => {
    const view = mount("b");
    await screen.findByTitle("file-00.txt");
    let late: StorageMessage | undefined;
    b.transport.sendImpl = (_session, message) => {
      if (message.type === "storage") late = message;
    };
    fireEvent.click(
      screen.getByRole("button", {
        name: "shared_files.next",
      }),
    );
    await waitFor(() => expect(late).toBeDefined());
    view.setActive(false);
    const count = queries().length;
    if (late) await a.transport.emit(a.session, late);
    await b.protocol.notify(
      b.session,
      "storage-changed",
      {},
    );
    await flushRtc();
    expect(queries()).toHaveLength(count);
    expect(screen.queryByTitle("file-60.txt")).toBeNull();
    view.select("other");
    view.setActive(true);
    await screen.findByText("shared_files.disconnected");
    b.transport.sendImpl = (_session, message) => {
      void a.transport.emit(a.session, message);
    };
    view.select("b");
    await screen.findByTitle("file-00.txt");
  });
  it.each([
    ["/client/b/sync", "/?panel=files&member=b"],
    [
      "/client/b/sync?room=meeting&conversation=old#video",
      "/?room=meeting&panel=files&member=b#video",
    ],
  ])(
    "redirects the old sync address %s to the file tab while preserving invitations",
    async (address, target) => {
      setAppState("profile", "clientId", "a");
      const history = createMemoryHistory();
      history.set({ value: address });
      render(() => (
        <MemoryRouter history={history}>
          <Route path="/client/:id/sync" component={Sync} />
          <Route path="/" component={() => <p>home</p>} />
        </MemoryRouter>
      ));
      await waitFor(() =>
        expect(history.get()).toBe(target),
      );
      expect(queries()).toHaveLength(0);
    },
  );
});
