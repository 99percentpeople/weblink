import type { FileCapabilities } from "@/libs/domain/file-storage";

/** UI fixtures supply operations; they do not resolve backing stores. */
export const fileCapabilities = {
  indexeddb: {
    save: "download",
    inlineSave: true,
    reveal: false,
  },
  directory: {
    save: "save-as",
    inlineSave: true,
    reveal: false,
  },
  native: {
    save: "save-as",
    inlineSave: false,
    reveal: true,
  },
} as const satisfies Record<string, FileCapabilities>;
