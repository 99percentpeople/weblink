/**
 * catch error for async function
 */
export async function catchError<T>(
  promise: Promise<T>,
): Promise<[undefined, T] | [Error]> {
  return promise.then(
    (data) => [undefined, data],
    (error) => [error],
  );
}

/**
 * catch error for sync function
 */
export function catchErrorSync<T>(
  fn: () => T,
): [undefined, T] | [Error] {
  try {
    return [undefined, fn()];
  } catch (error) {
    return [error as Error];
  }
}
