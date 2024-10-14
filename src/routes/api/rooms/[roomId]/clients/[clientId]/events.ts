import { EventEmitter } from "events";
import {
  clientEventEmitters,
  ClientEventMap,
  getRoom,
} from "@/libs/store";
import { Client } from "@/libs/core/type";
import { APIEvent } from "@solidjs/start/server";
import { json } from "@solidjs/router";

export async function GET(event: APIEvent) {
  const { roomId, clientId } = event.params;
  const room = getRoom(roomId);

  const client = room.clients.get(clientId);
  if (!client) {
    return json(
      { error: "client is require" },
      { status: 400 },
    );
  }
  const emitter = new EventEmitter<ClientEventMap>();

  clientEventEmitters.forEach((emitter) => {
    emitter.emit(`client-joined`, client);
  });

  clientEventEmitters.set(clientId, emitter);
  // SSE 连接
  const { readable, writable } = new TransformStream();
  const encoder = new TextEncoder();
  const writer = writable.getWriter();

  // 发送注释以保持连接
  writer.write(encoder.encode(":\n\n"));
  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(":\n\n"));
  }, 10000);
  const sendEvent = async (
    event: keyof ClientEventMap,
    data: any,
  ) => {
    await writer.write(
      `event: ${event}\n` +
        `data: ${JSON.stringify(data)}\n\n`,
    );
  };

  const onClientJoined = (client: Client) => {
    sendEvent("client-joined", client);
  };

  const onClientLeft = (client: Client) => {
    sendEvent("client-left", client);
  };

  emitter.on("client-joined", onClientJoined);
  emitter.on("client-left", onClientLeft);
  event.nativeEvent.node.res.addListener("close", () => {
    clearInterval(heartbeat);
    emitter.removeListener("client-joined", onClientJoined);
    emitter.removeListener("client-left", onClientLeft);
    clientEventEmitters.delete(clientId);

    writer.close();

    clientEventEmitters.forEach((emitter) => {
      emitter.emit(`client-left`, client);
    });
  });

  room.clients.forEach((client) => {
    if (client.clientId !== clientId) {
      emitter.emit("client-joined", client);
    }
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
