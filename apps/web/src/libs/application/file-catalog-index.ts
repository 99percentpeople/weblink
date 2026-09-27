import type { FileMetaData } from "@/libs/domain/file";
import type {
  ProtocolFileMetadata,
  StoragePage,
  StorageQuery,
} from "@/libs/domain/protocol";

const normalized = (text: string) =>
  text.normalize("NFKC").trim().toLowerCase();
const compare = (a: string | number, b: string | number) =>
  a < b ? -1 : a > b ? 1 : 0;

/** Metadata-only projection. Never retain or serialize browser File/cache state. */
export function toCatalogMetadata(
  info: FileMetaData,
): ProtocolFileMetadata {
  return {
    id: info.id,
    fileName: info.fileName,
    fileSize: info.fileSize,
    lastModified: info.lastModified,
    mimetype: info.mimetype,
    chunkSize: info.chunkSize,
    from: info.from,
    createdAt: info.createdAt,
    fingerprint: info.fingerprint && {
      ...info.fingerprint,
    },
  };
}

/** Updated by committed cache events, so paging never flushes/reads file databases. */
export class FileCatalogIndex {
  private readonly entries = new Map<
    string,
    ProtocolFileMetadata
  >();
  private readonly listeners = new Set<() => void>();

  update(id: string, info: FileMetaData | null): void {
    const previous = this.entries.get(id);
    const next =
      info?.isComplete &&
      info.isShared &&
      info.sharedReference &&
      info.fingerprint
        ? toCatalogMetadata(info)
        : undefined;
    if (JSON.stringify(previous) === JSON.stringify(next))
      return;
    if (next) this.entries.set(id, next);
    else this.entries.delete(id);
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Input is validated at the protocol boundary. ID is the stable final tie-breaker. */
  query(
    query: StorageQuery,
    sharingEnabled = true,
  ): StoragePage {
    const search = normalized(query.search ?? "");
    const items = sharingEnabled
      ? [...this.entries.values()].filter((item) =>
          normalized(item.fileName).includes(search),
        )
      : [];
    const sorts = query.sort?.length
      ? query.sort
      : [{ field: "fileName" as const, desc: false }];
    items.sort((a, b) => {
      for (const { field, desc } of sorts) {
        const av = a[field];
        const bv = b[field];
        // Missing optional metadata sorts as an empty string/zero on every client.
        const numeric =
          field === "fileSize" ||
          field === "createdAt" ||
          field === "lastModified";
        const order = numeric
          ? compare(
              (av as number | undefined) ?? 0,
              (bv as number | undefined) ?? 0,
            )
          : compare(
              normalized((av as string | undefined) ?? ""),
              normalized((bv as string | undefined) ?? ""),
            );
        if (order) return desc ? -order : order;
      }
      return compare(a.id, b.id);
    });
    const totalCount = items.length;
    const pageIndex = Math.min(
      query.pageIndex,
      Math.max(
        0,
        Math.ceil(totalCount / query.pageSize) - 1,
      ),
    );
    return {
      items: items
        .slice(
          pageIndex * query.pageSize,
          (pageIndex + 1) * query.pageSize,
        )
        .map((item) => ({
          ...item,
          fingerprint: item.fingerprint && {
            ...item.fingerprint,
          },
        })),
      totalCount,
      pageIndex,
      pageSize: query.pageSize,
      sharingEnabled,
    };
  }
}
