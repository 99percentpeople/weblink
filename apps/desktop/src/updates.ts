import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativeUpdateProgress,
  NativeUpdates,
} from "@weblink/platform";

export const nativeUpdates: NativeUpdates = {
  check: () => invoke("updates_check"),
  async install(version, onProgress) {
    const channel = new Channel<NativeUpdateProgress>();
    let active = true;
    channel.onmessage = (progress) => {
      if (active) onProgress(progress);
    };
    try {
      await invoke("updates_install", { version, channel });
    } finally {
      active = false;
    }
  },
};
