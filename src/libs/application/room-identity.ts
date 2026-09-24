import { signalingWebSocketUrl } from "@/libs/state/app-options";

/** Stable deployment identity; room history must not cross signaling backends. */
export function getRoomNamespace(): string {
  const endpoint = new URL(
    signalingWebSocketUrl || "/",
    window.location.href,
  );
  endpoint.hash = "";
  endpoint.username = "";
  endpoint.password = "";
  // Room selection and credentials do not identify the signaling deployment.
  endpoint.searchParams.delete("room");
  endpoint.searchParams.delete("pwd");
  return `websocket:${endpoint.href}`;
}
