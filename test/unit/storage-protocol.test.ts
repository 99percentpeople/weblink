import { describe, expect, it } from "vitest";
import {
  createSessionMessage,
  parseSessionMessage,
  validateSessionMessage,
  type StoragePage,
} from "@/libs/domain/protocol";

const peer = { clientId: "a", targetClientId: "b" };
const query = {
  pageIndex: 0,
  pageSize: 25,
  search: "report",
  sort: [{ field: "fileName" as const, desc: false }],
};
const request = () =>
  createSessionMessage(peer, "request-storage", query);
const page: StoragePage = {
  items: [
    { id: "f", fileName: "report.txt", fileSize: 10 },
  ],
  pageIndex: 0,
  pageSize: 25,
  totalCount: 1,
  sharingEnabled: true,
};

describe("paginated storage wire contract v2", () => {
  it("creates and round-trips versioned queries and page responses", () => {
    expect(request().version).toBe(2);
    expect(
      parseSessionMessage(JSON.stringify(request())),
    ).toMatchObject(query);
    const response = createSessionMessage(peer, "storage", {
      data: page,
    });
    expect(response.version).toBe(2);
    expect(
      parseSessionMessage(JSON.stringify(response)),
    ).toEqual(response);
  });

  it.each([
    { version: undefined },
    { version: 1 },
    { version: 3 },
    { pageIndex: -1 },
    { pageIndex: 0.5 },
    { pageIndex: Number.MAX_SAFE_INTEGER },
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: 1.5 },
    { search: 10 },
    { search: "x".repeat(257) },
    { sort: {} },
    { sort: [{ field: "status", desc: false }] },
    { sort: [{ field: "fileSize", desc: "false" }] },
    {
      sort: [
        { field: "fileSize", desc: false },
        { field: "fileSize", desc: true },
      ],
    },
  ])("rejects malformed query %j", (overrides) => {
    expect(() =>
      validateSessionMessage({
        ...request(),
        ...overrides,
      }),
    ).toThrow();
  });

  it.each([
    [],
    { ...page, pageSize: 101 },
    { ...page, totalCount: -1 },
    { ...page, totalCount: 0 },
    { ...page, pageIndex: 2 },
    { ...page, sharingEnabled: false },
    { ...page, sharingEnabled: undefined },
    { ...page, items: [{ ...page.items[0], file: {} }] },
    {
      ...page,
      items: [{ ...page.items[0], isComplete: true }],
    },
    {
      ...page,
      items: [page.items[0], page.items[0]],
      totalCount: 2,
    },
  ])("rejects invalid/legacy page %j", (data) => {
    const response = createSessionMessage(peer, "storage", {
      data: page,
    });
    expect(() =>
      validateSessionMessage({ ...response, data }),
    ).toThrow();
  });

  it("defines an envelope-only invalidation and rejects accidental data leakage", () => {
    const notification = createSessionMessage(
      peer,
      "storage-changed",
      {},
    );
    expect(Object.keys(notification).sort()).toEqual([
      "client",
      "createdAt",
      "id",
      "target",
      "type",
    ]);
    expect(validateSessionMessage(notification)).toEqual(
      notification,
    );
    expect(() =>
      validateSessionMessage({
        ...notification,
        data: page.items,
      }),
    ).toThrow();
  });
});
