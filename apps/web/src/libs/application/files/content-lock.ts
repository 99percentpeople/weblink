import { withExclusiveTask } from "@/libs/utils/exclusive-task";

/** Preserve the content-lock namespace used by existing browser clients. */
export function withContentLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  return withExclusiveTask(`content:${key}`, work);
}
