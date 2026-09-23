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
    self.postMessage({
      id,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
};
