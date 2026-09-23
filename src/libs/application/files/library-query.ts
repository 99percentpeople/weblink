import type { FileMetaData } from "@/libs/domain/file";

export type LibraryFile = FileMetaData & {
  referenceIds: string[];
};
export type FileKind =
  | "all"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "other";
export function fileKind(
  info: FileMetaData,
): Exclude<FileKind, "all"> {
  const mime = info.mimetype ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime.startsWith("text/") ||
    /pdf|document|spreadsheet|presentation/.test(mime) ||
    /\.(txt|md|pdf|docx?|xlsx?|pptx?|csv)$/i.test(
      info.fileName,
    )
  )
    return "document";
  return "other";
}

/** One visible row per content; per-offer aliases remain independent underneath. */
export function libraryFiles(
  infos: readonly FileMetaData[],
): LibraryFile[] {
  const groups = new Map<string, LibraryFile>();
  for (const info of infos) {
    if (info.contentStorage) continue;
    const key = info.contentKey ?? info.id;
    const previous = groups.get(key);
    if (!previous)
      groups.set(key, {
        ...info,
        aliases: [
          ...new Set([
            info.fileName,
            ...(info.aliases ?? []),
          ]),
        ],
        referenceIds: [info.id],
      });
    else {
      const preferred =
        info.libraryPinned && !previous.libraryPinned
          ? info
          : previous;
      groups.set(key, {
        ...preferred,
        aliases: [
          ...new Set([
            ...(previous.aliases ?? []),
            info.fileName,
            ...(info.aliases ?? []),
          ]),
        ],
        referenceIds: [...previous.referenceIds, info.id],
      });
    }
  }
  return [...groups.values()];
}

export function queryLibrary(
  files: readonly LibraryFile[],
  options: {
    search: string;
    kind: FileKind;
    status: "all" | "complete" | "incomplete";
    sort: "recent" | "name" | "size";
  },
): LibraryFile[] {
  const query = options.search
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  return files
    .filter(
      (file) =>
        (options.kind === "all" ||
          fileKind(file) === options.kind) &&
        (options.status === "all" ||
          !!file.isComplete ===
            (options.status === "complete")) &&
        (!query ||
          [file.fileName, ...(file.aliases ?? [])].some(
            (name) =>
              name
                .normalize("NFKC")
                .toLocaleLowerCase()
                .includes(query),
          )),
    )
    .sort(
      (a, b) =>
        (options.sort === "name"
          ? a.fileName.localeCompare(b.fileName)
          : options.sort === "size"
            ? b.fileSize - a.fileSize
            : (b.createdAt ?? 0) - (a.createdAt ?? 0)) ||
        a.id.localeCompare(b.id),
    );
}
