import type { ClipboardContent } from "./clipboard-content";
import { checkContent } from "./clipboard-content";

/** File-manager copies arrive as files, even when the selection is a picture. */
export async function browserClipboardContent(
  content: ClipboardContent,
  signal: AbortSignal,
): Promise<ClipboardContent> {
  signal.throwIfAborted();
  const files = content.filter(
    (entry) => entry.type === "file",
  );
  if (!files.length) return content;
  if (
    files.length !== 1 ||
    !/\.(png|jpe?g)$/i.test(files[0].name ?? "")
  )
    throw new Error("clipboard-file-unsupported");
  const image = new Image();
  const url = URL.createObjectURL(files[0].blob);
  const abort = () => {
    image.src = "";
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } =
      image;
    if (
      !width ||
      !height ||
      width * height > 32 * 1024 * 1024
    )
      throw new Error("Clipboard image is too large");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error(
          "Clipboard image conversion unavailable",
        );
      context.drawImage(image, 0, 0);
      const png = await new Promise<Blob>(
        (resolve, reject) => {
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(
                    new Error(
                      "Clipboard image conversion failed",
                    ),
                  ),
            "image/png",
          );
        },
      );
      signal.throwIfAborted();
      const result: ClipboardContent = [
        ...content.filter(
          (entry) =>
            entry.type !== "file" &&
            entry.type !== "image/png",
        ),
        { type: "image/png", blob: png },
      ];
      checkContent(result);
      return result;
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    URL.revokeObjectURL(url);
    image.src = "";
  }
}
