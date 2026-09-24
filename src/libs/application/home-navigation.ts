import { directConversationId } from "@/libs/domain/conversation";

export const HOME_PATH = "/";

export function isHomePath(path: string): boolean {
  const normalized = path.replace(/\/$/, "");
  return (
    [
      "",
      "/home",
      "/video",
      "/chat",
      "/file",
      "/setting",
    ].includes(normalized) ||
    /^\/(?:chat\/)?conversation\/[^/]+$/.test(normalized) ||
    /^\/(?:chat\/)?client\/[^/]+\/(?:chat|sync)$/.test(
      normalized,
    )
  );
}

export function sharedFilesHref(peerId: string): string {
  return `/?panel=files&member=${encodeURIComponent(peerId)}`;
}

export function conversationHref(id: string): string {
  return `/?conversation=${encodeURIComponent(id)}`;
}

/** Keep incoming invitations and media hashes while retiring old page URLs. */
export function legacyHomeHref(
  location: {
    pathname: string;
    search: string;
    hash: string;
  },
  localId: string,
): string {
  const search = new URLSearchParams(location.search);
  const path = location.pathname.replace(/\/$/, "");
  const conversation = path.match(
    /^\/(?:chat\/)?conversation\/([^/]+)$/,
  );
  const shared = path.match(/^\/client\/([^/]+)\/sync$/);
  const client = path.match(
    /^\/(?:chat\/)?client\/([^/]+)\/chat$/,
  );
  try {
    if (shared) {
      search.set("panel", "files");
      search.set("member", decodeURIComponent(shared[1]));
      search.delete("conversation");
    } else if (conversation)
      search.set(
        "conversation",
        decodeURIComponent(conversation[1]),
      );
    else if (client)
      search.set(
        "conversation",
        directConversationId(
          localId,
          decodeURIComponent(client[1]),
        ),
      );
  } catch {
    /* Invalid IDs leave the Home conversation picker available. */
  }
  if (path === "/chat")
    search.set("panel", "conversations");
  if (path === "/file") search.set("dialog", "files");
  if (path === "/setting") search.set("dialog", "settings");
  const query = search.toString();
  return `/${query ? `?${query}` : ""}${location.hash}`;
}
