// @vitest-environment node
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  packClipboard,
  unpackClipboard,
  fromNativeClipboard,
  toNativeClipboard,
  browserClipboardAccess,
  readBrowserClipboard,
  writeBrowserClipboard,
  beginBrowserClipboardWrite,
  browserClipboardFormats,
  fromPaste,
} from "@/libs/application/clipboard-content";
import {
  validClipboardRequest,
  CLIPBOARD_MAX_BYTES,
} from "@/libs/domain/protocol/clipboard";
import { handleDropItems } from "@/libs/utils/process-file";
vi.mock("@/libs/utils/process-file", () => ({
  compressFiles: vi.fn(
    async (files, name) =>
      new File(
        [JSON.stringify(Object.keys(files))],
        `${name}.zip`,
      ),
  ),
  handleDropItems: vi.fn(async () => []),
}));
describe("clipboard content boundaries", () => {
  it("counts file totals separately from manifest overhead and text", async () => {
    const content = [
      {
        type: "file" as const,
        name: "a",
        blob: new Blob(["abc"]),
      },
      {
        type: "file" as const,
        name: "b",
        blob: new Blob(["de"]),
      },
      {
        type: "text/plain" as const,
        blob: new Blob(["text longer than five bytes"]),
      },
    ];
    const bundle = await packClipboard(content, 5);
    expect(bundle.size).toBeGreaterThan(5);
    expect((await unpackClipboard(bundle, 5)).length).toBe(
      3,
    );
    await expect(packClipboard(content, 4)).rejects.toThrow(
      "MiB limit",
    );
    await expect(
      unpackClipboard(bundle, 4),
    ).rejects.toThrow("MiB limit");
  });
  it("supports files above the previous 64 MiB ceiling when configured", async () => {
    const blob = new Blob([
      new Uint8Array(65 * 1024 * 1024),
    ]);
    const content = [
      { type: "file" as const, name: "large.bin", blob },
    ];
    await expect(
      packClipboard(content, 64 * 1024 * 1024),
    ).rejects.toThrow("MiB limit");
    const bundle = await packClipboard(
      content,
      128 * 1024 * 1024,
    );
    const restored = await unpackClipboard(
      bundle,
      128 * 1024 * 1024,
    );
    expect(restored[0].blob.size).toBe(blob.size);
  });
  it("preserves Unicode text, rich alternatives, image bytes and multiple files", async () => {
    const content = [
      {
        type: "text/plain" as const,
        blob: new Blob(["中文🧪\n\t"]),
      },
      {
        type: "text/html" as const,
        blob: new Blob(["<b>中文</b>"]),
      },
      {
        type: "text/rtf" as const,
        blob: new Blob(["{\\rtf1 test}"]),
      },
      {
        type: "image/png" as const,
        blob: new Blob([new Uint8Array([0, 1, 128, 255])]),
      },
      {
        type: "file" as const,
        name: "空文件.txt",
        blob: new Blob([]),
      },
      {
        type: "file" as const,
        name: "data.bin",
        blob: new Blob([new Uint8Array([1, 2, 3])]),
      },
    ];
    const wire = await packClipboard(content);
    const restored = await unpackClipboard(wire);
    expect(
      restored.map((e) => [e.type, e.name, e.blob.size]),
    ).toEqual(
      content.map((e) => [e.type, e.name, e.blob.size]),
    );
    expect(await restored[0].blob.text()).toBe(
      "中文🧪\n\t",
    );
    expect(await toNativeClipboard(restored)).toEqual(
      await toNativeClipboard(content),
    );
  });
  it("rejects inconsistent lengths, duplicate formats, paths and trailing data", async () => {
    await expect(
      packClipboard([
        {
          type: "file",
          name: "../secret",
          blob: new Blob([]),
        },
      ]),
    ).rejects.toThrow();
    await expect(
      packClipboard([
        { type: "text/plain", blob: new Blob([]) },
        { type: "text/plain", blob: new Blob([]) },
      ]),
    ).rejects.toThrow();
    const file = await packClipboard([
      { type: "text/plain", blob: new Blob(["a"]) },
    ]);
    await expect(
      unpackClipboard(new Blob([file, "extra"])),
    ).rejects.toThrow("Trailing");
    await expect(
      unpackClipboard(file.slice(0, -1)),
    ).rejects.toThrow();
    await expect(
      unpackClipboard(
        new Blob([new Uint8Array([255, 255, 255, 255])]),
      ),
    ).rejects.toThrow();
  });
  it("converts native directories into individual ZIP files without exposing host paths", async () => {
    const result = await fromNativeClipboard([
      {
        type: "directory",
        path: "folder",
        group: "0",
        data: "",
      },
      {
        type: "directory",
        path: "folder/empty",
        group: "0",
        data: "",
      },
      {
        type: "file",
        name: "a.txt",
        path: "folder/a.txt",
        group: "0",
        data: btoa("hello"),
      },
      {
        type: "file",
        name: "b.txt",
        path: "b.txt",
        group: "1",
        data: btoa("world"),
      },
    ]);
    expect(result.map((e) => e.name)).toEqual([
      "b.txt",
      "folder.zip",
    ]);
    expect(await result[1].blob.text()).toContain(
      "folder/empty",
    );
  });
  it("validates protocol directions and size before allocating a transfer", () => {
    const base = { grantId: "grant", operationId: "op" };
    const offer = {
      ...base,
      action: "offer",
      direction: "paste",
      size: 500,
      kind: "text",
    };
    expect(validClipboardRequest(offer)).toBe(true);
    expect(
      validClipboardRequest({ ...offer, kind: "binary" }),
    ).toBe(true);
    for (const invalid of [
      {
        ...offer,
        size: CLIPBOARD_MAX_BYTES + 1,
      },
      {
        ...offer,
        size: -1,
      },
      {
        ...offer,
        direction: "cut",
        size: 20,
      },
      { ...offer, kind: "unknown" },
      { ...offer, kind: undefined },
      { ...base, action: "read", kind: "text" },
      { ...base, action: "read", size: 20 },
      { ...base, action: "read", files: "yes" },
      { ...offer, files: false },
      { ...offer, maxFileBytes: 0 },
      { ...offer, maxFileBytes: -1 },
      { ...offer, maxFileBytes: NaN },
      { ...offer, maxFileBytes: 1.5 },
      { ...offer, maxFileBytes: 512 * 1024 * 1024 + 1 },
      { ...base, action: "read", maxFileBytes: 5 },
      { ...base, action: "watch", maxFileBytes: 5 },
      { ...base, action: "prepare", grantId: "" },
      {
        ...offer,
        direction: "copy",
        size: NaN,
      },
    ])
      expect(validClipboardRequest(invalid)).toBe(false);
  });
  it("validates optional read format filters without changing legacy requests", () => {
    const base = { grantId: "grant", operationId: "op" };
    for (const action of ["read", "read-current"]) {
      for (const formats of [
        undefined,
        [],
        ["text/plain", "image/png"],
      ])
        expect(
          validClipboardRequest({
            ...base,
            action,
            formats,
          }),
        ).toBe(true);
      for (const formats of [
        null,
        "text/plain",
        ["file"],
        ["web application/x-weblink-clipboard"],
        ["text/plain", "text/plain"],
        [1],
      ])
        expect(
          validClipboardRequest({
            ...base,
            action,
            formats,
          }),
        ).toBe(false);
    }
    for (const action of [
      "prepare",
      "watch",
      "unwatch",
      "changed",
      "offer",
    ])
      expect(
        validClipboardRequest({
          ...base,
          action,
          formats: [],
        }),
      ).toBe(false);
  });
});

function browserClipboard() {
  const saved = new Map<string, Blob>();
  class Item {
    static supports = (type: string) =>
      type.startsWith("web ") ||
      ["text/plain", "text/html", "image/png"].includes(
        type,
      );
    constructor(
      readonly data: Record<string, Blob | Promise<Blob>>,
    ) {}
  }
  const write = vi.fn(async (items: Item[]) => {
    const data = await Promise.all(
      Object.entries(items[0].data).map(
        async ([type, value]) =>
          [type, await value] as const,
      ),
    );
    saved.clear();
    data.forEach(([type, value]) => saved.set(type, value));
  });
  const read = vi.fn(async () => [
    {
      types: [...saved.keys()],
      getType: async (type: string) => saved.get(type)!,
    },
  ]);
  vi.stubGlobal("ClipboardItem", Item);
  vi.stubGlobal("navigator", {
    clipboard: { read, write },
  });
  return { saved, write, read };
}
it("writes supported standard formats without packaging files or unsupported RTF", async () => {
  const s = browserClipboard();
  const content = [
    {
      type: "text/plain" as const,
      blob: new Blob(["text"]),
    },
    {
      type: "text/html" as const,
      blob: new Blob(["<b>text</b>"]),
    },
    {
      type: "image/png" as const,
      blob: new Blob([new Uint8Array([0, 255])]),
    },
    {
      type: "text/rtf" as const,
      blob: new Blob(["{\\rtf1 text}"]),
    },
    {
      type: "file" as const,
      name: "中文.bin",
      blob: new Blob([new Uint8Array([0, 255, 128, 1])]),
    },
  ];
  expect(browserClipboardFormats()).toEqual([
    "text/plain",
    "text/html",
    "image/png",
  ]);
  await writeBrowserClipboard(content);
  expect([...s.saved.keys()]).toEqual([
    "text/plain",
    "text/html",
    "image/png",
  ]);
  const restored = await readBrowserClipboard();
  expect(await toNativeClipboard(restored)).toEqual(
    await toNativeClipboard(content.slice(0, 3)),
  );
});
it("starts a standard text write during the gesture and waits for the transferred bytes", async () => {
  const s = browserClipboard();
  let resolve!: (
    content: import("@/libs/application/clipboard-content").ClipboardContent,
  ) => void;
  const pending = beginBrowserClipboardWrite(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  expect(s.write).toHaveBeenCalledOnce();
  expect(s.saved.size).toBe(0);
  resolve([
    {
      type: "text/plain",
      blob: new Blob(["中文\nabc"]),
    },
  ]);
  await pending;
  expect(await s.saved.get("text/plain")!.text()).toBe(
    "中文\nabc",
  );
  expect([...s.saved.keys()]).toEqual(["text/plain"]);
});
it("uses actual system paste data without reading custom browser formats", async () => {
  const s = browserClipboard();
  s.read.mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  const content = await fromPaste({
    getData: (type: string) =>
      type === "text/plain" ? "actual paste" : "",
    items: [],
  } as unknown as DataTransfer);
  expect(await content[0].blob.text()).toBe("actual paste");
  expect(s.read).not.toHaveBeenCalled();
});
it("keeps actual files exposed by the browser paste event for sending to the host", async () => {
  const s = browserClipboard();
  const file = new File(
    [new Uint8Array([0, 255, 128])],
    "local.bin",
  );
  vi.mocked(handleDropItems).mockResolvedValueOnce([file]);
  const content = await fromPaste({
    getData: () => "",
    items: [],
  } as unknown as DataTransfer);
  expect(content).toEqual([
    { type: "file", name: "local.bin", blob: file },
  ]);
  expect(s.read).not.toHaveBeenCalled();
});
it("preserves the clipboard instead of writing files as names or custom bundles", async () => {
  const s = browserClipboard();
  s.saved.set(
    "text/plain",
    new Blob(["existing clipboard"]),
  );
  const content = [
    {
      type: "file" as const,
      name: "data.bin",
      blob: new Blob(["abc"]),
    },
  ];
  await expect(
    writeBrowserClipboard(content),
  ).rejects.toThrow(
    "No supported browser clipboard format",
  );
  expect(s.write).not.toHaveBeenCalled();
  expect(await s.saved.get("text/plain")!.text()).toBe(
    "existing clipboard",
  );
  await expect(
    beginBrowserClipboardWrite(Promise.resolve(content)),
  ).rejects.toThrow("No plain text alternative");
  expect(await s.saved.get("text/plain")!.text()).toBe(
    "existing clipboard",
  );
});
it("ignores custom clipboard bundles and keeps standard text alternatives", async () => {
  const s = browserClipboard();
  s.saved.set(
    "web application/x-weblink-clipboard",
    new Blob(["old bundle"]),
  );
  s.saved.set("text/plain", new Blob(["standard text"]));
  const content = await readBrowserClipboard();
  expect(content.map((e) => e.type)).toEqual([
    "text/plain",
  ]);
  expect(await content[0].blob.text()).toBe(
    "standard text",
  );
});
it("conservatively excludes RTF when per-format detection is unavailable", () => {
  browserClipboard();
  vi.stubGlobal("ClipboardItem", class {});
  expect(browserClipboardFormats()).toEqual([
    "text/plain",
    "text/html",
    "image/png",
  ]);
});

afterEach(() => vi.unstubAllGlobals());
it("supports text-only browser APIs without requiring ClipboardItem or a context flag", async () => {
  const readText = vi.fn(async () => "clipboard text");
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("isSecureContext", false);
  vi.stubGlobal("ClipboardItem", undefined);
  vi.stubGlobal("navigator", {
    clipboard: { readText, writeText },
  });
  expect(browserClipboardAccess()).toEqual({
    read: true,
    write: true,
  });
  const content = await readBrowserClipboard();
  expect(browserClipboardFormats()).toEqual(["text/plain"]);
  expect(await content[0].blob.text()).toBe(
    "clipboard text",
  );
  await writeBrowserClipboard(content);
  expect(writeText).toHaveBeenCalledWith("clipboard text");
});
it("does not advertise rich writes without ClipboardItem and leaves reading independent", () => {
  vi.stubGlobal("ClipboardItem", undefined);
  vi.stubGlobal("navigator", {
    clipboard: { write: vi.fn(), read: vi.fn() },
  });
  expect(browserClipboardAccess()).toEqual({
    read: true,
    write: false,
  });
});
