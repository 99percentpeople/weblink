export interface McpServerConfig {
  /** IP literal or localhost; wildcard addresses listen on all interfaces. */
  host: string;
  /** Fixed listening port, from 1 through 65535. */
  port: number;
}
export const DEFAULT_MCP_SERVER: Readonly<McpServerConfig> =
  { host: "127.0.0.1", port: 32100 };

export interface McpTokenSummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  expired: boolean;
}
/** Opaque native call tickets never cross MCP/P2P transports. */
export interface NativeAutomationRequest {
  kind: "call";
  id: string;
  principal: {
    id: string;
    label: string;
    kind: "mcp" | "peer";
    generation?: string;
  };
  call: {
    /** Informational origin only; authority comes from the verified principal. */
    source?: { kind: "mcp" | "webmcp"; label: string };
    name: string;
    arguments: Record<string, unknown>;
  };
}
export type NativeAutomationEvent =
  | NativeAutomationRequest
  | { kind: "cancel"; id: string };
/** Verified device identity and the shared connection generation. */
export interface NativeAutomationPeer {
  id: string;
  generation: string;
}
export interface NativeAutomation {
  open(
    onRequest: (request: NativeAutomationEvent) => void,
  ): Promise<string>;
  /** Check the native page session; delayed renderer timers do not expire it. */
  heartbeat(epoch: string): Promise<void>;
  close(epoch: string): Promise<void>;
  /** Accept automation of this machine from MCP clients and remote peers. */
  configure(epoch: string, enabled: boolean): Promise<void>;
  /** Expose the MCP API independently of local automation authority. */
  configureMcp(
    epoch: string,
    enabled: boolean,
  ): Promise<void>;
  configureServer(
    epoch: string,
    config: McpServerConfig,
  ): Promise<void>;
  snapshot(epoch: string): Promise<unknown>;
  client(
    epoch: string,
    label: string,
    expiresAt: number | null,
  ): Promise<{
    id: string;
    token: string;
    endpoint: string;
  }>;
  updateClient(
    epoch: string,
    id: string,
    label: string,
    expiresAt: number | null,
  ): Promise<void>;
  removeClient(epoch: string, id: string): Promise<void>;
  decide(
    epoch: string,
    id: string,
    accepted: boolean,
    remember?: boolean,
  ): Promise<void>;
  revoke(epoch: string, id?: string): Promise<void>;
  peer(
    epoch: string,
    principal: NativeAutomationPeer,
    label: string,
  ): Promise<void>;
  peerPolicy(
    epoch: string,
    principal: NativeAutomationPeer,
    policy: Record<string, "ask" | "allow" | "deny">,
  ): Promise<void>;
  disconnect(
    epoch: string,
    principal: NativeAutomationPeer,
  ): Promise<void>;
  call(
    epoch: string,
    principal: NativeAutomationPeer,
    id: string,
    call: NativeAutomationRequest["call"],
  ): Promise<unknown>;
  cancel(epoch: string, id: string): Promise<void>;
  check(epoch: string, id: string): Promise<void>;
  action(
    epoch: string,
    id: string,
    binding?: Record<string, string>,
  ): Promise<Record<string, unknown>>;
  finish(
    epoch: string,
    id: string,
    result: unknown,
  ): Promise<void>;
}
