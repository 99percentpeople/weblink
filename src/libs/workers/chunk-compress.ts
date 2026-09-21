import { CompressionLevel } from "@/options";
import { deflateSync } from "fflate";

self.onmessage = (
  ev: MessageEvent<{
    data: Uint8Array;
    context?: any;
    option: {
      level: CompressionLevel;
    };
  }>,
) => {
  const { data, option, context } = ev.data;

  try {
    const compressed = deflateSync(data, {
      level: option.level,
    });

    self.postMessage(
      {
        data: compressed,
        context,
      },
      {
        transfer: [compressed.buffer as ArrayBuffer],
      },
    );
  } catch (error) {
    self.postMessage({
      error: (error as Error).message,
      context,
    });
  }
};
