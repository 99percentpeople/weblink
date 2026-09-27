import { zipSync } from "fflate";

self.onmessage = async (
  event: MessageEvent<{
    folderName: string;
    fileMap: Record<string, File>;
  }>,
) => {
  const { fileMap, folderName } = event.data;
  try {
    const bufferMap: Record<string, Uint8Array> = {};

    await Promise.all(
      Object.entries(fileMap).map(async ([path, file]) => {
        if (!file) {
          bufferMap[path] = null!;
          return;
        }

        const buffer = await file.arrayBuffer();
        bufferMap[path] = new Uint8Array(buffer);
      }),
    );

    const zipData = zipSync(bufferMap, {});

    const zipFile = new File(
      [zipData.buffer as ArrayBuffer],
      `${folderName}.zip`,
      {
        type: "application/zip",
        lastModified: Date.now(),
      },
    );

    self.postMessage({
      data: zipFile,
    });
  } catch (err) {
    self.postMessage({
      error: err,
    });
  }
};
