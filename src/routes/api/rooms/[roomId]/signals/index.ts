import { APIEvent } from "@solidjs/start/server";
import { getRoom, signalEventEmitters } from "@/libs/store";
import { ClientSignal } from "@/libs/core/services/type";
import { json } from "@solidjs/router";

export async function POST(event: APIEvent) {
  const { roomId } = event.params;

  const signal =
    (await event.request.json()) as ClientSignal;

  const room = getRoom(roomId);

  if (signal.targetClientId) {
    const emitter = signalEventEmitters.get(
      signal.targetClientId,
    );

    if (emitter) {
      emitter.emit("signal", signal);
    } else {
      room.signals.push(signal);
    }
  } else {
    signalEventEmitters.forEach((emitter, clientId) => {
      if (clientId !== signal.clientId)
        emitter.emit("signal", signal);
    });
  }

  return json(
    { message: "Signal sent" },
    {
      status: 200,
    },
  );
}
