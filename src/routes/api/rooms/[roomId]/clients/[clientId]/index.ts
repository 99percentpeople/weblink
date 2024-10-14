import { getRoom } from "@/libs/store";
import { APIEvent } from "@solidjs/start/server";
import { json } from "@solidjs/router";

export async function PUT(event: APIEvent) {
  const { roomId, clientId } = event.params;

  const room = getRoom(roomId);

  const existingClient = room.clients.get(clientId);
  if (!existingClient) {
    return json(
      { message: "Client not found" },
      { status: 404 },
    );
  }

  const updatedClient = {
    ...existingClient,
    ...(await event.request.json()),
    createAt: Date.now(),
  };

  room.clients.set(clientId, updatedClient);

  return json(
    { message: "Client updated" },
    { status: 200 },
  );
}
