import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativeKeyboard,
  NativeKeyboardEvent,
  RuntimeCapabilities,
} from "@weblink/platform";

export const nativeKeyboard: NativeKeyboard = {
  supported: async () =>
    (
      await invoke<RuntimeCapabilities>(
        "runtime_capabilities",
      )
    ).systemKeyboard === true,
  async start(exitShortcut, onEvent) {
    const sessionId = crypto.randomUUID();
    let closed = false;
    const events = new Channel<NativeKeyboardEvent>(
      (event) => {
        if (!closed) onEvent(event);
      },
    );
    try {
      await invoke("keyboard_start", {
        sessionId,
        exitShortcut,
        events,
      });
    } catch (error) {
      closed = true;
      await invoke("keyboard_stop", { sessionId }).catch(
        () => {},
      );
      throw error;
    }
    return {
      renew: (sequence) =>
        closed
          ? Promise.reject(
              new Error("Keyboard capture closed"),
            )
          : invoke("keyboard_renew", {
              sessionId,
              sequence,
            }),
      async close() {
        if (closed) return;
        closed = true;
        await invoke("keyboard_stop", { sessionId });
      },
    };
  },
};
