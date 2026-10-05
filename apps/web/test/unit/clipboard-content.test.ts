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
  supportsBrowserClipboardFiles,
  fromBrowserPaste,
  WEB_CLIPBOARD_FORMAT,
} from "@/libs/application/clipboard-content";
import {
  validClipboardRequest,
  CLIPBOARD_MAX_BYTES,
} from "@/libs/domain/protocol/clipboard";
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
      { ...base, action: "prepare", grantId: "" },
      {
        ...offer,
        direction: "copy",
        size: NaN,
      },
    ])
      expect(validClipboardRequest(invalid)).toBe(false);
  });
});

function customClipboard(supported = true) {
  const saved = new Map<string, Blob>();
  class Item {
    static supports = (type: string) =>
      type === WEB_CLIPBOARD_FORMAT
        ? supported
        : ["text/plain", "text/html", "image/png"].includes(
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
it("round trips binary files and filenames through the custom browser clipboard format", async () => {
  const s = customClipboard();
  const content = [
    {
      type: "file" as const,
      name: "中文.bin",
      blob: new Blob([new Uint8Array([0, 255, 128, 1])]),
    },
  ];
  expect(supportsBrowserClipboardFiles()).toBe(true);
  await writeBrowserClipboard(content);
  expect([...s.saved.keys()]).toEqual([
    WEB_CLIPBOARD_FORMAT,
  ]);
  const restored = await readBrowserClipboard();
  expect(await toNativeClipboard(restored)).toEqual(
    await toNativeClipboard(content),
  );
  const paste = await fromBrowserPaste(
    {
      getData: () => "",
      items: [],
    } as unknown as DataTransfer,
    true,
  );
  expect(await toNativeClipboard(paste)).toEqual(
    await toNativeClipboard(content),
  );
});
it("starts the custom write during the gesture and waits for the transferred bytes", async () => {
  const s = customClipboard();
  let resolve!: (
    content: import("@/libs/application/clipboard-content").ClipboardContent,
  ) => void;
  const pending = beginBrowserClipboardWrite(
    new Promise((yes) => {
      resolve = yes;
    }),
    true,
  );
  expect(s.write).toHaveBeenCalledOnce();
  expect(s.saved.size).toBe(0);
  resolve([
    {
      type: "file",
      name: "data.bin",
      blob: new Blob(["abc"]),
    },
  ]);
  await pending;
  expect(await s.saved.get("text/plain")!.text()).toBe(
    "data.bin",
  );
  expect((await readBrowserClipboard())[0].name).toBe(
    "data.bin",
  );
});
it("preserves real paste data when custom clipboard reading is denied", async () => {
  const s = customClipboard();
  s.read.mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  const content = await fromBrowserPaste(
    {
      getData: (type: string) =>
        type === "text/plain" ? "actual paste" : "",
      items: [],
    } as unknown as DataTransfer,
    true,
  );
  expect(await content[0].blob.text()).toBe("actual paste");
});
it("does not silently turn unsupported or malformed binary clipboard data into filenames", async () => {
  const s = customClipboard(false);
  const content = [
    {
      type: "file" as const,
      name: "data.bin",
      blob: new Blob(["abc"]),
    },
  ];
  await expect(
    writeBrowserClipboard(content),
  ).rejects.toThrow("unavailable");
  expect(s.write).not.toHaveBeenCalled();
  s.saved.set(WEB_CLIPBOARD_FORMAT, new Blob(["bad"]));
  await expect(readBrowserClipboard()).rejects.toThrow();
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
