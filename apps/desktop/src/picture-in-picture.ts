import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativePictureInPicture,
  NativePipState,
} from "@weblink/platform";

type WindowState = NativePipState & { revision: number };

export const nativePictureInPicture: NativePictureInPicture =
  {
    async watch(onState) {
      const watchId = crypto.randomUUID();
      let closed = false;
      let revision = -1;
      const receive = (state: WindowState) => {
        if (closed || state.revision <= revision) return;
        revision = state.revision;
        onState({
          active: state.active,
          transitioning: state.transitioning,
          titleBarHeight: state.titleBarHeight,
        });
      };
      const events = new Channel<WindowState>(receive);
      try {
        await invoke("pip_watch", { watchId, events });
      } catch (error) {
        closed = true;
        await invoke("pip_unwatch", { watchId }).catch(
          () => {},
        );
        throw error;
      }
      const call = async (command: string, args = {}) => {
        if (closed)
          throw new Error(
            "Picture-in-picture session ended",
          );
        const state = await invoke<WindowState | undefined>(
          command,
          { watchId, ...args },
        );
        // Command replies settle state before callers proceed; ignore older
        // channel events that may arrive after the reply or a newer operation.
        if (state) receive(state);
      };
      return {
        configure: (options) =>
          call("pip_configure", { options }),
        enter: () => call("pip_enter"),
        exit: () => call("pip_exit"),
        drag: () => call("pip_drag"),
        async close() {
          if (closed) return;
          closed = true;
          await invoke("pip_unwatch", { watchId });
        },
      };
    },
  };
