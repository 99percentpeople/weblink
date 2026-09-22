import { DBNAME_PREFIX } from "@/constants";
import { assembleCachedFile } from "../cache/chunk-assembly";

// This worker owns the only final write. Do not instantiate the cache (or spawn
// a second merge worker), and do not post a File until its transaction commits.
self.onmessage = async (
  event: MessageEvent<{ fileId: string }>,
) => {
  let db: IDBDatabase | undefined;
  try {
    const { fileId } = event.data;
    if (typeof fileId !== "string" || !fileId)
      throw new Error("Invalid file ID");
    db = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(
          `${DBNAME_PREFIX}${fileId}`,
        );
        // Deletion won the race: never recreate an empty cache during finalization.
        request.onupgradeneeded = () =>
          request.transaction?.abort();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      },
    );
    const connection = db;
    connection.onversionchange = () => connection.close();
    const result = await assembleCachedFile(
      connection,
      fileId,
    );
    connection.close();
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({
      error: {
        name:
          error instanceof Error ||
          error instanceof DOMException
            ? error.name
            : "Error",
        message:
          error instanceof Error ||
          error instanceof DOMException
            ? error.message
            : String(error),
      },
    });
  } finally {
    db?.close();
  }
};
