/** Resolve only after the transaction commits, never merely after a request succeeds. */
export function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener(
      "complete",
      () => resolve(),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () =>
        reject(
          transaction.error ??
            new DOMException(
              "IndexedDB transaction aborted",
              "AbortError",
            ),
        ),
      { once: true },
    );
  });
}
export function requestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
