import {
  transferRemoteContent,
  type RemoteContentTransferJob,
} from "./remote-content-transfer";
export type ClipboardTransferJob = RemoteContentTransferJob;
export function transferClipboard(
  options: Omit<
    Parameters<typeof transferRemoteContent>[0],
    "origin" | "fileName"
  >,
  job: ClipboardTransferJob,
  size: number,
  kind: Parameters<typeof transferRemoteContent>[3],
  file?: File,
) {
  return transferRemoteContent(
    {
      ...options,
      origin: "clipboard",
      fileName: "Clipboard",
    },
    job,
    size,
    kind,
    file,
  );
}
