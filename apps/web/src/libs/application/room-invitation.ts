export interface RoomInvitation {
  roomId?: string;
  password: string | null;
}

/** Only room links replace credentials; an omitted password means an unprotected room. */
export function parseRoomInvitation(search: {
  id?: string | string[];
  pwd?: string | string[];
}): RoomInvitation | null {
  const roomId = Array.isArray(search.id)
    ? search.id[0]
    : search.id;
  const password = Array.isArray(search.pwd)
    ? search.pwd[0]
    : search.pwd;
  if (roomId === undefined && password === undefined)
    return null;
  return {
    ...(roomId !== undefined ? { roomId } : {}),
    password: password || null,
  };
}
