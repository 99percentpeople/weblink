import type { ClipboardEntry } from "@weblink/platform";
import {
  CLIPBOARD_MAX_ENTRIES,
  type ClipboardContentKind,
} from "../domain/protocol/clipboard";
import {
  compressFiles,
  handleDropItems,
} from "../utils/process-file";

import {
  MAX_REMOTE_FILE_BYTES,
  REMOTE_CONTENT_BYTES,
  remoteBundleLimit,
} from "../domain/protocol/remote-file-limits";

const WEB_CLIPBOARD_MIME =
  "application/x-weblink-clipboard";
export const WEB_CLIPBOARD_FORMAT = `web ${WEB_CLIPBOARD_MIME}`;

export type ClipboardContent = {
  type:
    | "text/plain"
    | "text/html"
    | "text/rtf"
    | "image/png"
    | "file";
  name?: string;
  blob: Blob;
}[];
export function clipboardContentKind(
  content: ClipboardContent,
): ClipboardContentKind {
  return content.some(
    (entry) =>
      entry.type === "file" || entry.type === "image/png",
  )
    ? "binary"
    : "text";
}
const formats = [
  "text/plain",
  "text/html",
  "text/rtf",
  "image/png",
  "file",
];
export function checkContent(
  content: ClipboardContent,
  maxFileBytes = MAX_REMOTE_FILE_BYTES,
): void {
  if (
    !content.length ||
    content.length > CLIPBOARD_MAX_ENTRIES
  )
    throw new Error(
      "Clipboard is empty or exceeds 4096 entries",
    );
  const fileBytes = content
    .filter((e) => e.type === "file")
    .reduce((n, e) => n + e.blob.size, 0);
  const otherBytes = content
    .filter((e) => e.type !== "file")
    .reduce((n, e) => n + e.blob.size, 0);
  if (fileBytes > maxFileBytes)
    throw new Error(
      `Files exceed the ${maxFileBytes / 1024 / 1024} MiB limit`,
    );
  if (otherBytes > REMOTE_CONTENT_BYTES)
    throw new Error("Clipboard text/images exceed 64 MiB");
  const seen = new Set<string>();
  for (const e of content) {
    if (
      !formats.includes(e.type) ||
      (e.type === "file" &&
        (!e.name ||
          e.name.length > 240 ||
          /[<>:"/\\|?*\x00-\x1f]/.test(e.name) ||
          /[. ]$/.test(e.name)))
    )
      throw new Error(
        "Invalid clipboard format or filename",
      );
    const key =
      e.type === "file"
        ? `file:${e.name!.toLowerCase()}`
        : e.type;
    if (seen.has(key))
      throw new Error(
        "Duplicate clipboard format or filename",
      );
    seen.add(key);
  }
}
export async function packClipboard(
  content: ClipboardContent,
  maxFileBytes = MAX_REMOTE_FILE_BYTES,
): Promise<File> {
  checkContent(content, maxFileBytes);
  const metadata = new TextEncoder().encode(
    JSON.stringify(
      content.map(({ type, name, blob }) => ({
        type,
        name,
        size: blob.size,
      })),
    ),
  );
  if (metadata.length > 1024 * 1024)
    throw new Error("Clipboard manifest is too large");
  const header = new ArrayBuffer(4);
  new DataView(header).setUint32(0, metadata.length, true);
  const file = new File(
    [header, metadata, ...content.map((e) => e.blob)],
    "Clipboard.weblink",
    { type: WEB_CLIPBOARD_MIME },
  );
  if (file.size > remoteBundleLimit(maxFileBytes))
    throw new Error(
      "Clipboard bundle exceeds its size limit",
    );
  return file;
}
export async function unpackClipboard(
  file: Blob,
  maxFileBytes = MAX_REMOTE_FILE_BYTES,
): Promise<ClipboardContent> {
  if (
    file.size < 5 ||
    file.size > remoteBundleLimit(maxFileBytes)
  )
    throw new Error("Invalid clipboard size");
  const length = new DataView(
    await file.slice(0, 4).arrayBuffer(),
  ).getUint32(0, true);
  if (length > 1024 * 1024 || length > file.size - 4)
    throw new Error("Invalid clipboard manifest");
  const meta: unknown = JSON.parse(
    await file.slice(4, 4 + length).text(),
  );
  if (
    !Array.isArray(meta) ||
    meta.length > CLIPBOARD_MAX_ENTRIES
  )
    throw new Error("Invalid clipboard entries");
  let offset = 4 + length;
  const result: ClipboardContent = meta.map((e) => {
    if (
      !e ||
      !formats.includes(e.type) ||
      (e.name !== undefined &&
        typeof e.name !== "string") ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      e.size > file.size - offset
    )
      throw new Error("Invalid clipboard entry");
    const blob = file.slice(
      offset,
      offset + e.size,
      e.type === "file"
        ? "application/octet-stream"
        : e.type,
    );
    offset += e.size;
    return { type: e.type, name: e.name, blob };
  });
  if (offset !== file.size)
    throw new Error("Trailing clipboard bytes");
  checkContent(result, maxFileBytes);
  return result;
}
const decode = (entry: ClipboardEntry) =>
  Uint8Array.from(atob(entry.data), (c) => c.charCodeAt(0));
export async function fromNativeClipboard(
  entries: ClipboardEntry[],
  signal?: AbortSignal,
  maxFileBytes = MAX_REMOTE_FILE_BYTES,
): Promise<ClipboardContent> {
  const groups = new Map<
    string,
    Record<string, File | null>
  >();
  const directoryGroups = new Set(
    entries
      .filter((e) => e.type === "directory")
      .map((e) => e.group),
  );
  const result: ClipboardContent = [];
  let fileBytes = 0,
    otherBytes = 0;
  if (entries.length > CLIPBOARD_MAX_ENTRIES)
    throw new Error("Too many clipboard entries");
  for (const entry of entries) {
    signal?.throwIfAborted();
    const bytes = decode(entry);
    if (entry.type === "file") fileBytes += bytes.length;
    else otherBytes += bytes.length;
    if (fileBytes > maxFileBytes)
      throw new Error(
        `Files exceed the ${maxFileBytes / 1024 / 1024} MiB limit`,
      );
    if (otherBytes > REMOTE_CONTENT_BYTES)
      throw new Error(
        "Clipboard text/images exceed 64 MiB",
      );
    if (
      directoryGroups.has(entry.group) &&
      entry.group !== undefined
    ) {
      if (
        !entry.path ||
        entry.path
          .split("/")
          .some((p) => !p || p === "." || p === "..") ||
        entry.path.includes("\\")
      )
        throw new Error("Invalid clipboard directory path");
      const files =
        groups.get(entry.group) ??
        (Object.create(null) as Record<
          string,
          File | null
        >);
      files[entry.path] =
        entry.type === "directory"
          ? null
          : new File([bytes], entry.name!);
      groups.set(entry.group, files);
    } else if (entry.type !== "directory")
      result.push({
        type: entry.type,
        name: entry.name,
        blob: new Blob([bytes], { type: entry.type }),
      });
  }
  for (const files of groups.values()) {
    const name = Object.keys(files)[0].split("/")[0];
    const blob = await compressFiles(files, name, signal);
    result.push({ type: "file", name: blob.name, blob });
  }
  checkContent(result, maxFileBytes);
  return result;
}
export async function toNativeClipboard(
  content: ClipboardContent,
): Promise<ClipboardEntry[]> {
  checkContent(content);
  const entries: ClipboardEntry[] = [];
  for (const e of content) {
    const data = new Uint8Array(await e.blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < data.length; i += 32768)
      binary += String.fromCharCode(
        ...data.subarray(i, i + 32768),
      );
    entries.push({
      type: e.type,
      name: e.name,
      data: btoa(binary),
    });
  }
  return entries;
}
/** Capture data and entry handles during the actual paste event, before yielding. */
export function fromPaste(
  data: DataTransfer,
  signal?: AbortSignal,
  maxFileBytes = MAX_REMOTE_FILE_BYTES,
): Promise<ClipboardContent> {
  const result: ClipboardContent = [];
  for (const type of [
    "text/plain",
    "text/html",
    "text/rtf",
  ] as const) {
    const text = data.getData(type);
    if (text)
      result.push({
        type,
        blob: new Blob([text], { type }),
      });
  }
  const files = handleDropItems(data.items, signal, {
    maxBytes: maxFileBytes,
    maxEntries: CLIPBOARD_MAX_ENTRIES,
  });
  return files.then((files) => {
    for (const file of files) {
      if (
        file.type === "image/png" &&
        files.length === 1 &&
        !result.length
      )
        result.push({ type: "image/png", blob: file });
      else
        result.push({
          type: "file",
          name: file.name,
          blob: file,
        });
    }
    checkContent(result, maxFileBytes);
    return result;
  });
}
/** Probe APIs and permission state only; never read or overwrite clipboard data to test access. */
export function browserClipboardAccess() {
  const api = globalThis.navigator?.clipboard;
  return {
    read:
      typeof api?.read === "function" ||
      typeof api?.readText === "function",
    write:
      (typeof ClipboardItem !== "undefined" &&
        typeof api?.write === "function") ||
      typeof api?.writeText === "function",
  };
}

export async function readBrowserClipboard(): Promise<ClipboardContent> {
  if (!browserClipboardAccess().read)
    throw new Error("Clipboard read unavailable");
  if (typeof navigator.clipboard.read !== "function") {
    return [
      {
        type: "text/plain",
        blob: new Blob(
          [await navigator.clipboard.readText()],
          { type: "text/plain" },
        ),
      },
    ];
  }
  const items = await navigator.clipboard.read();
  for (const item of items)
    if (item.types.includes(WEB_CLIPBOARD_FORMAT))
      return unpackClipboard(
        await item.getType(WEB_CLIPBOARD_FORMAT),
      );
  const result: ClipboardContent = [];
  for (const item of items)
    for (const type of item.types)
      if (
        ["text/plain", "text/html", "image/png"].includes(
          type,
        )
      )
        result.push({
          type: type as ClipboardContent[number]["type"],
          blob: await item.getType(type),
        });
  checkContent(result);
  return result;
}
export function supportsBrowserClipboardFiles(): boolean {
  return (
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined" &&
    ClipboardItem.supports?.(WEB_CLIPBOARD_FORMAT) === true
  );
}

/** Start writing within the copy gesture, before a potentially long network transfer. */
export function beginBrowserClipboardWrite(
  content: Promise<ClipboardContent>,
  files: boolean,
): Promise<void> | undefined {
  if (
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard?.write !== "function"
  )
    return;
  const custom = files && supportsBrowserClipboardFiles();
  const text = content.then((entries) => {
    checkContent(entries);
    const plain = entries.find(
      (entry) => entry.type === "text/plain",
    );
    if (plain) return plain.blob;
    if (!custom)
      throw new Error("No plain text alternative");
    return new Blob(
      [
        entries
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.name)
          .join("\n"),
      ],
      { type: "text/plain" },
    );
  });
  void text.catch(() => {});
  const data: Record<string, Promise<Blob>> = {
    "text/plain": text,
  };
  if (custom) {
    const bundle = content.then(packClipboard);
    void bundle.catch(() => {});
    data[WEB_CLIPBOARD_FORMAT] = bundle;
  }
  try {
    return navigator.clipboard.write([
      new ClipboardItem(data),
    ]);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Keep event data alive as the fallback; custom binary formats require the async read API. */
export function fromBrowserPaste(
  data: DataTransfer,
  readCustom: boolean,
  maxFileBytes = MAX_REMOTE_FILE_BYTES,
): Promise<ClipboardContent> {
  const fallback = fromPaste(data, undefined, maxFileBytes);
  void fallback.catch(() => {});
  if (
    !readCustom ||
    typeof navigator.clipboard?.read !== "function"
  )
    return fallback;
  return navigator.clipboard.read().then(
    async (items) => {
      for (const item of items)
        if (item.types.includes(WEB_CLIPBOARD_FORMAT))
          return unpackClipboard(
            await item.getType(WEB_CLIPBOARD_FORMAT),
            maxFileBytes,
          );
      return fallback;
    },
    () => fallback,
  );
}
export async function writeBrowserClipboard(
  content: ClipboardContent,
): Promise<void> {
  checkContent(content);
  if (!browserClipboardAccess().write)
    throw new Error("Clipboard write unavailable");
  if (
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard.write !== "function"
  ) {
    const text = content.find(
      (entry) => entry.type === "text/plain",
    );
    if (!text)
      throw new Error(
        "Only plain text clipboard writing is supported",
      );
    await navigator.clipboard.writeText(
      await text.blob.text(),
    );
    return;
  }
  const data = Object.fromEntries(
    content
      .filter(
        (e) =>
          e.type !== "file" &&
          (typeof ClipboardItem.supports !== "function" ||
            ClipboardItem.supports(e.type)),
      )
      .map((e) => [e.type, e.blob]),
  );
  if (content.some((entry) => entry.type === "file")) {
    if (!supportsBrowserClipboardFiles())
      throw new Error("Browser file clipboard unavailable");
    data[WEB_CLIPBOARD_FORMAT] =
      await packClipboard(content);
  }
  if (!Object.keys(data).length)
    return Promise.reject(
      new Error("No supported browser clipboard format"),
    );
  return navigator.clipboard.write([
    new ClipboardItem(data),
  ]);
}
