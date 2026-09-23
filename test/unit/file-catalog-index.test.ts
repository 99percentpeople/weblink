import { describe, expect, it, vi } from "vitest";
import { FileCatalogIndex } from "@/libs/application/file-catalog-index";
import type { FileMetaData } from "@/libs/domain/file";

const file = (
  id: string,
  overrides: Partial<FileMetaData> = {},
): FileMetaData => ({
  id,
  fileName: `${id}.txt`,
  fileSize: 10,
  chunkSize: 4,
  isComplete: true,
  ...overrides,
});
const query = { pageIndex: 0, pageSize: 2 };

describe("file catalog metadata index", () => {
  it("pages the full matching catalog, with stable sorting and detached DTOs", () => {
    const index = new FileCatalogIndex();
    for (const id of ["d", "b", "c", "a", "e"])
      index.update(id, file(id));
    const page = index.query({ ...query, pageIndex: 1 });
    expect(page.totalCount).toBe(5);
    expect(page.items.map((item) => item.id)).toEqual([
      "c",
      "d",
    ]);
    page.items[0].fileName = "changed";
    expect(
      index.query({ ...query, pageIndex: 1 }).items[0]
        .fileName,
    ).toBe("c.txt");
  });

  it("searches all filenames before slicing, case-insensitively with NFKC normalization", () => {
    const index = new FileCatalogIndex();
    for (let i = 0; i < 8; i++)
      index.update(String(i), file(String(i)));
    index.update(
      "report",
      file("report", { fileName: "ＲＥＰＯＲＴ.PDF" }),
    );
    const result = index.query({
      ...query,
      search: "  report  ",
    });
    expect(result.totalCount).toBe(1);
    expect(result.items[0].id).toBe("report");
    expect(
      index.query({ ...query, search: "missing" })
        .totalCount,
    ).toBe(0);
  });

  it("sorts the full directory by metadata and uses ID to break ties", () => {
    const index = new FileCatalogIndex();
    index.update("b", file("b", { fileSize: 20 }));
    index.update("a", file("a", { fileSize: 20 }));
    index.update("c", file("c", { fileSize: 99 }));
    expect(
      index
        .query({
          ...query,
          sort: [{ field: "fileSize", desc: true }],
        })
        .items.map((item) => item.id),
    ).toEqual(["c", "a"]);
    expect(
      index
        .query({
          ...query,
          sort: [
            { field: "fileSize", desc: true },
            { field: "fileName", desc: true },
          ],
        })
        .items.map((item) => item.id),
    ).toEqual(["c", "b"]);
  });

  it("clamps a removed last page and uses page zero for an empty catalog", () => {
    const index = new FileCatalogIndex();
    for (const id of ["a", "b", "c"])
      index.update(id, file(id));
    index.update("c", null);
    expect(
      index.query({ ...query, pageIndex: 5 }),
    ).toMatchObject({ pageIndex: 0, totalCount: 2 });
    expect(
      index.query({
        ...query,
        pageIndex: 5,
        search: "none",
      }),
    ).toMatchObject({
      pageIndex: 0,
      totalCount: 0,
      items: [],
    });
  });

  it("indexes completed files only and never exposes browser/cache fields", () => {
    const index = new FileCatalogIndex();
    index.update(
      "incomplete",
      file("incomplete", { isComplete: false }),
    );
    index.update(
      "complete",
      file("complete", {
        file: new File(["x"], "private.txt"),
        chunkCount: 10,
        isMerging: true,
      }),
    );
    const page = index.query(query);
    expect(page.totalCount).toBe(1);
    expect(page.items[0]).not.toHaveProperty("file");
    expect(page.items[0]).not.toHaveProperty("chunkCount");
    expect(page.items[0]).not.toHaveProperty("isComplete");
    expect(page.items[0]).not.toHaveProperty("isMerging");
  });

  it("emits once for visible changes but not chunk progress or unchanged metadata", () => {
    const index = new FileCatalogIndex();
    const changed = vi.fn();
    const stop = index.onChange(changed);
    index.update(
      "a",
      file("a", { isComplete: false, chunkCount: 1 }),
    );
    index.update(
      "a",
      file("a", { isComplete: false, chunkCount: 2 }),
    );
    expect(changed).not.toHaveBeenCalled();
    index.update("a", file("a"));
    index.update("a", file("a", { chunkCount: 3 }));
    expect(changed).toHaveBeenCalledTimes(1);
    index.update("a", file("a", { fileName: "new.txt" }));
    index.update("a", null);
    index.update("a", null);
    expect(changed).toHaveBeenCalledTimes(3);
    stop();
    index.update("a", file("a"));
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("returns no catalog metadata or counts when sharing is disabled", () => {
    const index = new FileCatalogIndex();
    index.update("a", file("a"));
    expect(
      index.query({ ...query, pageIndex: 5 }, false),
    ).toEqual({
      items: [],
      totalCount: 0,
      pageIndex: 0,
      pageSize: 2,
      sharingEnabled: false,
    });
  });

  it("keeps room attachments out of the remote catalog without altering local metadata", () => {
    const index = new FileCatalogIndex();
    const changed = vi.fn();
    index.onChange(changed);
    const attachment = file("room", {
      roomAttachment: true,
      roomOfferId: "offer",
      from: "sender",
    });
    index.update("room", attachment);
    index.update("public", file("public"));
    expect(
      index.query(query).items.map((item) => item.id),
    ).toEqual(["public"]);
    expect(changed).toHaveBeenCalledTimes(1);

    index.update(
      "public",
      file("public", { roomAttachment: true }),
    );
    expect(index.query(query).totalCount).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(attachment).toMatchObject({
      isComplete: true,
      roomAttachment: true,
      roomOfferId: "offer",
    });
  });
});
