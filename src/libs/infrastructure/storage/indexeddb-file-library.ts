import type {
  ContentRecord,
  FileLibraryRepository,
  FileReference,
} from "@/libs/domain/file-library";
import {
  requestResult,
  transactionDone,
} from "./chunk-assembly";

/** Only metadata lives here. File bytes remain in the existing chunk databases. */
export class IndexedDbFileLibrary implements FileLibraryRepository {
  private opening?: Promise<IDBDatabase>;
  constructor(
    private readonly name = "weblink-file-library-v1",
  ) {}
  private database(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise(
      (resolve, reject) => {
        const request = indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("contents", {
            keyPath: "key",
          });
          request.result
            .createObjectStore("references", {
              keyPath: "id",
            })
            .createIndex("contentKey", "contentKey");
        };
        request.onerror = () => {
          this.opening = undefined;
          reject(request.error);
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.opening = undefined;
          };
          resolve(db);
        };
      },
    ));
  }
  private async read<T>(
    store: string,
    get: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const tx = (await this.database()).transaction(
      store,
      "readonly",
    );
    const [value] = await Promise.all([
      requestResult(get(tx.objectStore(store))),
      transactionDone(tx),
    ]);
    return value;
  }
  contents(): Promise<ContentRecord[]> {
    return this.read("contents", (store) => store.getAll());
  }
  content(key: string): Promise<ContentRecord | undefined> {
    return this.read("contents", (store) => store.get(key));
  }
  references(key?: string): Promise<FileReference[]> {
    return this.read("references", (store) =>
      key === undefined
        ? store.getAll()
        : store.index("contentKey").getAll(key),
    );
  }
  reference(
    id: string,
  ): Promise<FileReference | undefined> {
    return this.read("references", (store) =>
      store.get(id),
    );
  }
  async claim(record: ContentRecord): Promise<boolean> {
    const tx = (await this.database()).transaction(
      "contents",
      "readwrite",
    );
    const done = transactionDone(tx);
    const store = tx.objectStore("contents");
    const exists = await requestResult(
      store.get(record.key),
    );
    if (!exists) store.add(record);
    await done;
    return !exists;
  }
  async commit(
    record: ContentRecord,
    reference: FileReference,
  ): Promise<void> {
    const tx = (await this.database()).transaction(
      ["contents", "references"],
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore("contents").put({
      ...record,
      state: "ready",
    });
    tx.objectStore("references").put(reference);
    await done;
  }
  async putReference(
    reference: FileReference,
  ): Promise<void> {
    const tx = (await this.database()).transaction(
      ["contents", "references"],
      "readwrite",
    );
    const done = transactionDone(tx);
    const content = await requestResult<
      ContentRecord | undefined
    >(tx.objectStore("contents").get(reference.contentKey));
    if (content?.state !== "ready") {
      tx.abort();
      await done.catch(() => {});
      throw new Error(
        "File content is no longer available",
      );
    }
    tx.objectStore("references").put(reference);
    await done;
  }
  async removeReference(id: string): Promise<void> {
    const tx = (await this.database()).transaction(
      "references",
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore("references").delete(id);
    await done;
  }
  async removeContent(key: string): Promise<void> {
    const tx = (await this.database()).transaction(
      ["contents", "references"],
      "readwrite",
    );
    const done = transactionDone(tx);
    const store = tx.objectStore("references");
    const keys = await requestResult(
      store.index("contentKey").getAllKeys(key),
    );
    keys.forEach((id) => store.delete(id));
    tx.objectStore("contents").delete(key);
    await done;
  }
}
