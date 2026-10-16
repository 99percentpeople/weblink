import { fingerprintBlob } from "./fingerprint";

self.onmessage = async (
  event: MessageEvent<{ id: string; file: Blob }>,
) => {
  const { id, file } = event.data;
  let last = 0;
  try {
    const fingerprint = await fingerprintBlob(
      file,
      (bytes) => {
        const now = performance.now();
        if (now - last < 100 && bytes !== file.size) return;
        last = now;
        self.postMessage({ id, bytes });
      },
    );
    self.postMessage({ id, fingerprint });
  } catch (error) {
    const details = error as {
      message?: unknown;
      name?: unknown;
    } | null;
    self.postMessage({
      id,
      error:
        typeof details?.message === "string"
          ? details.message
          : String(error),
      errorName:
        typeof details?.name === "string"
          ? details.name
          : undefined,
    });
  }
};
