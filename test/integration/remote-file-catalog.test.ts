import { describe, expect, it, vi } from "vitest";
import { RemoteFileCatalog } from "@/libs/application/remote-file-catalog";
import type {
  StoragePage,
  StorageQuery,
} from "@/libs/domain/protocol";
import {
  deferred,
  flushRtc,
} from "../support/rtc-transport";

const query: StorageQuery = {
  pageIndex: 2,
  pageSize: 10,
  search: "report",
  sort: [{ field: "fileSize", desc: true }],
};
const page = (pageIndex = 2): StoragePage => ({
  items: [],
  pageIndex,
  pageSize: 10,
  totalCount: 21,
  sharingEnabled: true,
});
function setup() {
  const calls: {
    query: StorageQuery;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<StoragePage>>;
  }[] = [];
  const state = vi.fn();
  const disposed = vi.fn();
  const view = new RemoteFileCatalog(
    query,
    (query, signal) => {
      const result = deferred<StoragePage>();
      calls.push({ query, signal, result });
      return result.promise;
    },
    state,
    disposed,
  );
  return { view, calls, state, disposed };
}

describe("remote directory current-page coordinator", () => {
  it("coalesces notifications during a query and ignores its stale result", async () => {
    const { view, calls } = setup();
    view.refresh();
    view.refresh();
    view.refresh();
    view.refresh();
    expect(calls).toHaveLength(1);
    calls[0].result.resolve(page());
    await flushRtc();
    expect(view.state.page).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1].query).toEqual(query);
    calls[1].result.resolve(page());
    await flushRtc();
    expect(view.state).toMatchObject({
      page: page(),
      loading: false,
      stale: false,
    });
    view.dispose();
  });

  it("preserves the last page while refreshing with identical search and sort", async () => {
    const { view, calls } = setup();
    view.refresh();
    calls[0].result.resolve(page());
    await flushRtc();
    view.refresh();
    expect(view.state).toMatchObject({
      page: page(),
      loading: true,
      stale: true,
    });
    expect(calls[1].query).toEqual(query);
    view.dispose();
  });

  it("aborts superseded queries and prevents an old response replacing a new search", async () => {
    const { view, calls } = setup();
    view.refresh();
    view.setQuery({
      ...query,
      pageIndex: 0,
      search: "new",
    });
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].result.resolve(page());
    await flushRtc();
    expect(view.state.page).toBeUndefined();
    expect(calls[1].query).toMatchObject({
      pageIndex: 0,
      search: "new",
    });
    calls[1].result.resolve(page(0));
    await flushRtc();
    expect(view.state.page?.pageIndex).toBe(0);
    view.dispose();
  });

  it("accepts a clamped page without triggering a duplicate controlled-table query", async () => {
    const { view, calls } = setup();
    view.refresh();
    calls[0].result.resolve(page(1));
    await flushRtc();
    view.setQuery({ ...query, pageIndex: 1 });
    expect(calls).toHaveLength(1);
    view.refresh();
    expect(calls[1].query.pageIndex).toBe(1);
    view.dispose();
  });

  it("exposes failures as stale state and can retry", async () => {
    const { view, calls } = setup();
    view.refresh();
    calls[0].result.reject(new Error("network"));
    await flushRtc();
    expect(view.state).toMatchObject({
      loading: false,
      stale: true,
      error: "network",
    });
    view.refresh();
    calls[1].result.resolve(page());
    await flushRtc();
    expect(view.state.error).toBeUndefined();
    expect(view.state.stale).toBe(false);
    view.dispose();
  });

  it("clears state on session close and ignores late replies or further refreshes", async () => {
    const { view, calls, disposed } = setup();
    view.refresh();
    view.close();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].result.resolve(page());
    await flushRtc();
    view.refresh();
    view.setQuery({ ...query, pageIndex: 0 });
    view.dispose();
    expect(calls).toHaveLength(1);
    expect(view.state.page).toBeUndefined();
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
