import { AutomationError } from "@weblink/automation";
import { createAutomationStorage } from "./automation-storage";
import {
  Channel,
  invoke as tauriInvoke,
} from "@tauri-apps/api/core";
import type {
  NativeAutomation,
  NativeAutomationEvent,
} from "@weblink/platform";
const invoke = async <T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> => {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    const message = String(error);
    throw new AutomationError(
      /^[A-Z][A-Z0-9_]{1,64}$/.test(message)
        ? message
        : "EXECUTION_FAILED",
      message,
    );
  }
};
const storage = createAutomationStorage(invoke);
export const nativeAutomation: NativeAutomation = {
  open: (onRequest) => {
    const channel = new Channel<NativeAutomationEvent>();
    channel.onmessage = onRequest;
    return storage.open({ channel });
  },
  heartbeat: (epoch) =>
    invoke("automation_heartbeat", { epoch }),
  close: (epoch) => storage.close(epoch),
  configure: (epoch, enabled) =>
    invoke("automation_configure", { epoch, enabled }),
  configureMcp: (epoch, enabled) =>
    invoke("automation_mcp_configure", { epoch, enabled }),
  configureServer: (epoch, config) =>
    storage.change("automation_server_configure", {
      epoch,
      config,
    }),
  snapshot: (epoch) =>
    invoke("automation_snapshot", { epoch }),
  client: (epoch, label, expiresAt) =>
    storage.change("automation_client", {
      epoch,
      label,
      expiresAt,
    }),
  updateClient: (epoch, id, label, expiresAt) =>
    storage.change("automation_client_update", {
      epoch,
      id,
      label,
      expiresAt,
    }),
  removeClient: (epoch, id) =>
    storage.change("automation_client_remove", {
      epoch,
      id,
    }),
  decide: (epoch, id, accepted, remember = false) =>
    invoke("automation_decide", {
      epoch,
      id,
      accepted,
      remember,
    }),
  revoke: (epoch, id) =>
    invoke("automation_revoke", { epoch, id }),
  peer: (epoch, principal, label) =>
    invoke("automation_peer", {
      epoch,
      principal,
      label,
    }),
  peerPolicy: (epoch, principal, policy) =>
    invoke("automation_peer_policy", {
      epoch,
      principal,
      policy,
    }),
  disconnect: (epoch, principal) =>
    invoke("automation_disconnect", { epoch, principal }),
  call: (epoch, principal, id, call) =>
    invoke("automation_call", {
      epoch,
      principal,
      id,
      call,
    }),
  cancel: (epoch, id) =>
    invoke("automation_cancel", { epoch, id }),
  check: (epoch, id) =>
    invoke("automation_check", { epoch, id }),
  action: (epoch, id, binding) =>
    invoke("automation_action", { epoch, id, binding }),
  finish: (epoch, id, result) =>
    invoke("automation_finish", { epoch, id, result }),
};
