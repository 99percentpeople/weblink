import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  P2PProtocol,
  type StorageQuery,
} from "@/libs/domain/protocol";
import { FileCatalogIndex } from "@/libs/application/file-catalog-index";
import { FileCatalogService } from "@/libs/application/file-catalog-service";
import {
  FakeRtcTransport,
  makeSession,
  flushRtc,
} from "../support/rtc-transport";

const disposers: (() => void)[] = [];
function side(client: string, target: string) {
  const session = makeSession(client, target);
  const transport = new FakeRtcTransport();
  const protocol = new P2PProtocol(transport);
  const index = new FileCatalogIndex();
  let sharing = true;
  let ready = true;
  const service = new FileCatalogService({
    protocol,
    index,
    getSessions: () => [session],
    isReady: () => ready,
    canList: () => sharing,
    onSessionClosed: (handler) =>
      transport.onSessionClosed(handler),
  });
  service.syncSharing();
  disposers.push(() => {
    service.dispose();
    protocol.dispose();
  });
  return {
    session,
    transport,
    protocol,
    index,
    service,
    setSharing(value: boolean) {
      sharing = value;
      service.syncSharing();
    },
    setReady(value: boolean) {
      ready = value;
    },
  };
}
function pair() {
  const a = side("a", "b");
  const b = side("b", "a");
  a.transport.sendImpl = (_session, message) => {
    void b.transport.emit(b.session, message);
  };
  b.transport.sendImpl = (_session, message) => {
    void a.transport.emit(a.session, message);
  };
  return { a, b };
}
function add(peer: ReturnType<typeof side>, id: string) {
  peer.index.update(id, {
    id,
    fileName: `${id}.txt`,
    fileSize: 10,
    chunkSize: 4,
    isComplete: true,
  });
}
const query: StorageQuery = {
  pageIndex: 1,
  pageSize: 2,
  search: "report",
  sort: [{ field: "fileName", desc: false }],
};
const requests = (peer: ReturnType<typeof side>) =>
  peer.transport.sendCalls.filter(
    (call) => call.message.type === "request-storage",
  );
const notices = (peer: ReturnType<typeof side>) =>
  peer.transport.sendCalls.filter(
    (call) => call.message.type === "storage-changed",
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

describe("file catalog two-peer workflows", () => {
  it("refreshes only the current page with unchanged query after one payloadless notification", async () => {
    const { a, b } = pair();
    for (let i = 0; i < 6; i++) add(b, `report-${i}`);
    add(b, "other");
    await vi.advanceTimersByTimeAsync(100);
    const view = a.service.watch(a.session, query, vi.fn());
    await flushRtc();
    expect(
      view.state.page?.items.map((item) => item.id),
    ).toEqual(["report-2", "report-3"]);
    expect(view.state.page?.totalCount).toBe(6);
    const before = notices(b).length;
    add(b, "report-6");
    add(b, "report-7");
    add(b, "report-8");
    await vi.advanceTimersByTimeAsync(100);
    await flushRtc();
    expect(notices(b)).toHaveLength(before + 1);
    expect(
      Object.keys(notices(b).at(-1)!.message).sort(),
    ).toEqual([
      "client",
      "createdAt",
      "id",
      "target",
      "type",
    ]);
    expect(requests(a)).toHaveLength(2);
    expect(requests(a)[1].message).toMatchObject(query);
    expect(view.state.page?.totalCount).toBe(9);
    expect(view.state.page?.pageIndex).toBe(1);
  });

  it("clamps the current page after remote deletion", async () => {
    const { a, b } = pair();
    for (let i = 0; i < 3; i++) add(b, `report-${i}`);
    await vi.advanceTimersByTimeAsync(100);
    const view = a.service.watch(a.session, query, vi.fn());
    await flushRtc();
    expect(view.state.page?.pageIndex).toBe(1);
    b.index.update("report-2", null);
    await vi.advanceTimersByTimeAsync(100);
    await flushRtc();
    expect(view.state.page).toMatchObject({
      totalCount: 2,
      pageIndex: 0,
    });
    view.refresh();
    await flushRtc();
    expect(requests(a).at(-1)!.message).toMatchObject({
      pageIndex: 0,
      search: "report",
    });
  });

  it("invalidates on sharing changes and sends no subsequent catalog changes to a denied peer", async () => {
    const { a, b } = pair();
    add(b, "report-0");
    await vi.advanceTimersByTimeAsync(100);
    const view = a.service.watch(a.session, query, vi.fn());
    await flushRtc();
    b.setSharing(false);
    await flushRtc();
    expect(view.state.page).toMatchObject({
      sharingEnabled: false,
      items: [],
      totalCount: 0,
    });
    const count = notices(b).length;
    add(b, "private-new");
    await vi.advanceTimersByTimeAsync(100);
    expect(notices(b)).toHaveLength(count);
    b.setSharing(true);
    await flushRtc();
    expect(view.state.page).toMatchObject({
      sharingEnabled: true,
      totalCount: 1,
    });
  });

  it("does not fetch off-screen directories; reopening reads a fresh page", async () => {
    const { a, b } = pair();
    add(b, "report-0");
    await vi.advanceTimersByTimeAsync(100);
    expect(requests(a)).toHaveLength(0);
    const view = a.service.watch(a.session, query, vi.fn());
    await flushRtc();
    view.dispose();
    add(b, "report-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(requests(a)).toHaveLength(1);
    const next = a.service.watch(a.session, query, vi.fn());
    await flushRtc();
    expect(next.state.page?.totalCount).toBe(2);
  });

  it("isolates notification ownership by session object", async () => {
    const { a, b } = pair();
    const view = a.service.watch(a.session, query, vi.fn());
    await flushRtc();
    const other = makeSession("a", "c");
    const { createSessionMessage } =
      await import("@/libs/domain/protocol");
    await a.transport.emit(
      other,
      createSessionMessage(
        makeSession("c", "a"),
        "storage-changed",
        {},
      ),
    );
    expect(requests(a)).toHaveLength(1);
    a.transport.close(a.session);
    expect(view.state.page).toBeUndefined();
    expect(view.state.loading).toBe(false);
    b.setReady(false);
    add(b, "report-0");
    await vi.advanceTimersByTimeAsync(100);
    expect(notices(b)).toHaveLength(0);
  });

  it("disposes debounced broadcasts and listeners", async () => {
    const a = side("a", "b");
    add(a, "report-0");
    a.service.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(notices(a)).toHaveLength(0);
    expect(() =>
      a.service.watch(a.session, query, vi.fn()),
    ).toThrow("disposed");
  });
});
