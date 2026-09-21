import { inflateSync } from "fflate";

self.onmessage = (
  ev: MessageEvent<{
    data: Uint8Array;
    context?: any;
  }>,
) => {
  const { data, context } = ev.data;
  try {
    const uncompressed = inflateSync(data);
    self.postMessage(
      {
        data: uncompressed,
        context,
      },
      {
        transfer: [uncompressed.buffer as ArrayBuffer],
      },
    );
  } catch (error) {
    self.postMessage({
      error: (error as Error).message,
      context,
    });
  }
};
