import { CreateRoom, getRoom } from "@/libs/store";
import { json } from "@solidjs/router";
import { APIEvent } from "@solidjs/start/server";

export async function POST(event: APIEvent) {
  const data = (await event.request.json()) as CreateRoom;
  const room = getRoom(data.roomId);
  if (data.password) {
    if (room.passwordHash) {
      return json(
        { error: "password has been setted" },
        { status: 403 },
      );
    }
    room.passwordHash = await bcrypt.hash(
      data.password,
      10,
    );
  }

  return json({ message: "room created" }, { status: 200 });
}
