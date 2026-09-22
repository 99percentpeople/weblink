import type {
  P2PProtocol,
  ProtocolSession,
  StorageQuery,
} from "@/libs/domain/protocol";
import type { FileCatalogIndex } from "./file-catalog-index";
import {
  RemoteFileCatalog,
  type RemoteCatalogState,
} from "./remote-file-catalog";

export interface FileCatalogServiceOptions<
  S extends ProtocolSession,
> {
  protocol: Pick<
    P2PProtocol<S>,
    "call" | "handle" | "on" | "notify"
  >;
  index: Pick<FileCatalogIndex, "query" | "onChange">;
  getSessions(): Iterable<S>;
  isReady(session: S): boolean;
  canList(session: S): boolean;
  onSessionClosed(
    handler: (session: S) => void,
  ): () => void;
}

/** Application-lifetime directory provider and invalidation router; no UI/browser dependencies. */
export class FileCatalogService<S extends ProtocolSession> {
  private readonly views = new Map<RemoteFileCatalog, S>();
  private readonly sharing = new Map<S, boolean>();
  private readonly stops: (() => void)[];
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly options: FileCatalogServiceOptions<S>,
  ) {
    const { protocol, index } = options;
    this.stops = [
      protocol.handle(
        "request-storage",
        ({ session, message }) =>
          index.query(message, options.canList(session)),
      ),
      protocol.on("storage-changed", ({ session }) => {
        for (const [view, owner] of this.views)
          if (owner === session) view.refresh();
      }),
      index.onChange(() => this.scheduleNotification()),
      options.onSessionClosed((session) => {
        this.sharing.delete(session);
        for (const [view, owner] of this.views)
          if (owner === session) view.close();
      }),
    ];
  }

  watch(
    session: S,
    query: StorageQuery,
    onState: (state: RemoteCatalogState) => void,
  ): RemoteFileCatalog {
    if (this.disposed)
      throw new Error("File catalog service is disposed");
    const view = new RemoteFileCatalog(
      query,
      (query, signal) =>
        this.options.protocol.call(
          session,
          "request-storage",
          query,
          { signal },
        ),
      onState,
      () => {
        this.views.delete(view);
      },
    );
    this.views.set(view, session);
    view.refresh();
    return view;
  }

  /** Called by the composition's reactive privacy effect, including changes to false. */
  syncSharing(): void {
    if (this.disposed) return;
    const sessions = new Set(this.options.getSessions());
    for (const session of this.sharing.keys())
      if (!sessions.has(session))
        this.sharing.delete(session);
    for (const session of sessions) {
      const enabled = this.options.canList(session);
      const previous = this.sharing.get(session);
      this.sharing.set(session, enabled);
      if (previous !== undefined && previous !== enabled)
        this.notify(session);
    }
  }

  private scheduleNotification(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const session of this.options.getSessions())
        if (this.options.canList(session))
          this.notify(session);
    }, 100);
  }

  private notify(session: S): void {
    if (this.disposed || !this.options.isReady(session))
      return;
    // Payloadless invalidation. The next page request re-checks current privacy policy.
    void this.options.protocol
      .notify(session, "storage-changed", {})
      .catch((error) => {
        if (!this.disposed)
          console.warn(
            "[FileCatalog] notification failed",
            error,
          );
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.stops.forEach((stop) => stop());
    for (const view of this.views.keys()) view.dispose();
    this.sharing.clear();
  }
}
