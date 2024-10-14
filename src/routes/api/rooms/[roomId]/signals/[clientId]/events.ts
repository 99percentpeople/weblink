import { EventEmitter } from "events";
import { APIEvent } from "@solidjs/start/server";
import {
  getRoom,
  signalEventEmitters,
  SignalEventsMap,
} from "@/libs/store";
import { ClientSignal } from "@/libs/core/services/type";
import { json } from "@solidjs/router";

export async function GET(event: APIEvent) {
  const { roomId, clientId } = event.params;
  if (!roomId) {
    return json(
      { error: "roomId is required" },
      { status: 400 },
    );
  }
  if (!clientId) {
    return json(
      { error: "clientId is required" },
      { status: 400 },
    );
  }

  const room = getRoom(roomId);

  const emitter = new EventEmitter<SignalEventsMap>();
  // console.log(signalEventEmitters);

  signalEventEmitters.set(clientId, emitter);
  // SSE 连接
  const { readable, writable } = new TransformStream();
  const encoder = new TextEncoder();
  const writer = writable.getWriter();

  // 发送注释以保持连接
  writer.write(encoder.encode(":\n\n"));
  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(":\n\n"));
  }, 10000);

  const sendSignal = async (signal: ClientSignal) => {
    // console.log(
    //   `on send signal from ${signal.clientId} to ${signal.targetClientId} `,
    // );
    if (
      !signal.targetClientId ||
      signal.targetClientId === clientId
    ) {
      await writer.write(
        encoder.encode(
          `event: signal\n` +
            `data: ${JSON.stringify(signal)}\n\n`,
        ),
      );
    }
  };

  emitter.on("signal", sendSignal);

  event.nativeEvent.node.res.addListener("close", () => {
    clearInterval(heartbeat);
    emitter.removeListener("signal", sendSignal);
    signalEventEmitters.delete(clientId);
    room.signals = room.signals.filter(
      (signal) => signal.clientId !== clientId,
    );

    writer.close();
  });

  // console.log(
  //   `try send cached signals to`,
  //   clientId,
  //   `signals length ${room.signals.length}`,
  // );

  for (let i = room.signals.length - 1; i >= 0; i--) {
    const cachedSignal = room.signals[i];
    if (cachedSignal.targetClientId === clientId) {
      if (emitter.emit("signal", room.signals[i])) {
        console.log(`send signal to`, clientId);
        room.signals.splice(i, 1);
      }
    }
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
