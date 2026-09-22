import {
  batch,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import type { PeerSession } from "@/libs/domain/session";
import type {
  StoragePage,
  StorageQuery,
} from "@/libs/domain/protocol";
import type { FileCatalogService } from "@/libs/application/file-catalog-service";
import type {
  RemoteFileCatalog,
  RemoteCatalogState,
} from "@/libs/application/remote-file-catalog";

/** Only active views fetch pages. Re-entering/reconnecting always establishes a fresh page. */
export function createRemoteCatalog(
  catalog: Pick<FileCatalogService<PeerSession>, "watch">,
  session: Accessor<PeerSession | undefined>,
  query: Accessor<StorageQuery>,
  onPage: (page: StoragePage) => void,
) {
  const [state, setState] =
    createSignal<RemoteCatalogState>({
      loading: false,
      stale: true,
    });
  const [view, setView] = createSignal<RemoteFileCatalog>();
  createEffect(() => {
    const owner = session();
    setState({ loading: false, stale: true });
    if (!owner) return;
    const active = catalog.watch(
      owner,
      untrack(query),
      (next) => {
        batch(() => {
          setState(next);
          if (next.page && !next.loading && !next.stale)
            onPage(next.page);
        });
      },
    );
    setView(active);
    onCleanup(() => {
      active.dispose();
      setView(undefined);
    });
  });
  createEffect(() => view()?.setQuery(query()));
  return { state, refresh: () => view()?.refresh() };
}
