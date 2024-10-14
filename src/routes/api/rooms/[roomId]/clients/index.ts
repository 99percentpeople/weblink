import { getRoom } from "@/libs/store";
import { Client, CreateClient } from "@/libs/core/type";
import { APIEvent } from "@solidjs/start/server";
import { json } from "@solidjs/router";
import bcrypt from "bcryptjs";
export async function POST(event: APIEvent) {
  const { roomId } = event.params;
  const room = getRoom(roomId);
  const client =
    (await event.request.json()) as CreateClient;
  if (room.passwordHash) {
    if (!client.password) {
      return json(
        { error: "该房间需要密码才能加入。" },
        {
          status: 401,
        },
      );
    }
    const passwordMatch = await bcrypt.compare(
      client.password,
      room.passwordHash,
    );

    if (!passwordMatch) {
      return json(
        { error: "密码错误。" },
        {
          status: 401,
        },
      );
    }
  }
  room.clients.set(client.clientId, client);

  return json(
    { message: "Client created" },
    {
      status: 200,
    },
  );
}
