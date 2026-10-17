import { expect, it } from "vitest";
import type { FileMetaData } from "@/libs/domain/file";
import { libraryFiles } from "@/libs/application/files/library-query";

it("filters by actual mount before deduplication so another directory cannot supply the row or its actions", () => {
  const old: FileMetaData = {
    id: "old",
    contentKey: "same-content",
    fileName: "old-name.pdf",
    fileSize: 10,
    storageMountId: "directory-old",
    libraryPinned: true,
  };
  const current: FileMetaData = {
    ...old,
    id: "current",
    fileName: "current-name.pdf",
    storageMountId: "directory-current",
    libraryPinned: false,
  };
  const alias: FileMetaData = {
    ...current,
    id: "alias",
    fileName: "alias.pdf",
  };
  const files = [old, current, alias];
  expect(libraryFiles(files)).toHaveLength(1);
  expect(libraryFiles(files, "directory-current")).toEqual([
    expect.objectContaining({
      id: "current",
      storageMountId: "directory-current",
      aliases: ["current-name.pdf", "alias.pdf"],
      referenceIds: ["current", "alias"],
    }),
  ]);
  expect(libraryFiles(files, "directory-old")).toEqual([
    expect.objectContaining({
      id: "old",
      referenceIds: ["old"],
    }),
  ]);
});

it("keeps unfinished and temporarily unavailable files in their original mount and migrated files in their reported mount", () => {
  const legacy: FileMetaData = {
    id: "legacy",
    fileName: "legacy.txt",
    fileSize: 2,
    storageMountId: "indexeddb",
  };
  const partial: FileMetaData = {
    ...legacy,
    id: "partial",
    storageMountId: "native-first",
    isComplete: false,
    cachedBytes: 1,
  };
  const unavailable: FileMetaData = {
    ...partial,
    id: "unavailable",
    storageUnavailable: "Permission denied",
  };
  const deleted: FileMetaData = {
    ...partial,
    id: "deleted",
    storageMissing: true,
  };
  const unknown: FileMetaData = {
    ...legacy,
    id: "unknown",
    storageMountId: undefined,
    storageUnavailable: "Mount unavailable",
  };
  const files = [
    legacy,
    partial,
    unavailable,
    deleted,
    unknown,
  ];
  expect(
    libraryFiles(files, "native-first").map(
      (file) => file.id,
    ),
  ).toEqual(["partial", "unavailable"]);
  expect(libraryFiles(files, "native-next")).toEqual([]);
  expect(
    libraryFiles(files, "indexeddb").map((file) => file.id),
  ).toEqual(["legacy"]);
  expect(
    libraryFiles(files).map((file) => file.id),
  ).toEqual([
    "legacy",
    "partial",
    "unavailable",
    "unknown",
  ]);
});
