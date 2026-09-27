export const HOME_PATH = "/";

export function isHomePath(path: string): boolean {
  return path.replace(/\/+$/, "") === "";
}

export function sharedFilesHref(peerId: string): string {
  return `/?panel=files&member=${encodeURIComponent(peerId)}`;
}

export function conversationHref(id: string): string {
  return `/?panel=chat&conversation=${encodeURIComponent(id)}`;
}
