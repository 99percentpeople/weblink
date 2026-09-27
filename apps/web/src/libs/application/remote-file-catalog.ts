import type {
  StoragePage,
  StorageQuery,
} from "@/libs/domain/protocol";

export type RemoteCatalogState = {
  page?: StoragePage;
  loading: boolean;
  stale: boolean;
  error?: string;
};

const snapshot = (query: StorageQuery): StorageQuery => ({
  pageIndex: query.pageIndex,
  pageSize: query.pageSize,
  search: query.search?.trim() ?? "",
  sort: query.sort?.map((sort) => ({ ...sort })) ?? [],
});

/** One active page query. Invalidations coalesce; superseded replies cannot commit. */
export class RemoteFileCatalog {
  private query: StorageQuery;
  private generation = 0;
  private dirty = false;
  private running = false;
  private disposed = false;
  private controller?: AbortController;
  private current: RemoteCatalogState = {
    loading: false,
    stale: true,
  };

  constructor(
    query: StorageQuery,
    private readonly fetch: (
      query: StorageQuery,
      signal: AbortSignal,
    ) => Promise<StoragePage>,
    private readonly onState: (
      state: RemoteCatalogState,
    ) => void,
    private readonly onDispose: () => void,
  ) {
    this.query = snapshot(query);
  }

  get state(): RemoteCatalogState {
    return this.current;
  }

  private publish(state: RemoteCatalogState): void {
    this.current = state;
    this.onState(state);
  }

  setQuery(query: StorageQuery): void {
    if (this.disposed) return;
    const next = snapshot(query);
    if (JSON.stringify(next) === JSON.stringify(this.query))
      return;
    this.query = next;
    this.controller?.abort();
    this.current = { loading: false, stale: true };
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    this.generation++;
    this.dirty = true;
    this.publish({
      ...this.current,
      loading: true,
      stale: true,
      error: undefined,
    });
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.disposed || this.running || !this.dirty)
      return;
    this.running = true;
    this.dirty = false;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const page = await this.fetch(
        snapshot(this.query),
        controller.signal,
      );
      if (this.disposed || generation !== this.generation)
        return;
      // Accept a provider's last-page clamp before notifying the controlled table.
      this.query = {
        ...this.query,
        pageIndex: page.pageIndex,
      };
      this.publish({ page, loading: false, stale: false });
    } catch (error) {
      if (this.disposed || generation !== this.generation)
        return;
      this.publish({
        ...this.current,
        loading: false,
        stale: true,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      this.running = false;
      if (this.controller === controller)
        this.controller = undefined;
      if (!this.disposed && this.dirty) void this.run();
    }
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.publish({ loading: false, stale: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort();
    this.onDispose();
  }
}
