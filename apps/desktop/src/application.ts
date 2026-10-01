import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativeApplication,
  NativeCloseRequest,
} from "@weblink/platform";

export const nativeApplication: NativeApplication = {
  configure: (options) =>
    invoke("application_configure", { options }),
  async watchCloseRequests(onRequest) {
    const watchId = crypto.randomUUID();
    let closed = false;
    const events = new Channel<NativeCloseRequest>(
      (request) => {
        if (!closed) onRequest(request);
      },
    );
    try {
      await invoke("application_close_watch", {
        watchId,
        events,
      });
    } catch (error) {
      closed = true;
      await invoke("application_close_unwatch", {
        watchId,
      }).catch(() => {});
      throw error;
    }
    return {
      respond: (requestId, response, remember) =>
        closed
          ? Promise.reject(new Error("Close watcher ended"))
          : invoke("application_close_respond", {
              watchId,
              requestId,
              response,
              remember,
            }),
      async close() {
        if (closed) return;
        closed = true;
        await invoke("application_close_unwatch", {
          watchId,
        });
      },
    };
  },
};
