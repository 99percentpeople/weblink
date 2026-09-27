import { catchError } from "@/libs/catch";
import { generateHMAC } from "./utils/encrypt/hmac";

export type TurnServerOptions = {
  url: string;
  username: string;
  password: string;
  authMethod: string;
};

/** Drop removed/invalid methods when loading old persisted options or invite links. */
export function isTurnServerOptions(
  value: unknown,
): value is TurnServerOptions {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<TurnServerOptions>;
  return (
    typeof turn.url === "string" &&
    typeof turn.username === "string" &&
    typeof turn.password === "string" &&
    (turn.authMethod === "longterm" ||
      turn.authMethod === "hmac")
  );
}

export function sanitizeTurnServers(
  value: unknown,
): TurnServerOptions[] {
  return Array.isArray(value)
    ? value.filter(isTurnServerOptions)
    : [];
}

export type IceServerOptions = {
  stuns: string[];
  turns: TurnServerOptions[];
};

/**
 * Convert one configured TURN endpoint to an RTCIceServer.
 */
export async function parseTurnServer(
  turn: TurnServerOptions,
): Promise<RTCIceServer> {
  const { authMethod, username, password, url } = turn;
  if (authMethod === "hmac") {
    const timestamp =
      Math.floor(Date.now() / 1000) + 24 * 3600;
    const hmacUsernameArr = [timestamp.toString()];
    if (username.trim().length !== 0) {
      hmacUsernameArr.push(username);
    }
    const hmacUsername = hmacUsernameArr.join(":");
    const credential = await generateHMAC(
      password,
      hmacUsername,
    );
    return {
      urls: url,
      username: hmacUsername,
      credential,
    } satisfies RTCIceServer;
  }

  if (authMethod === "longterm") {
    return {
      urls: url,
      username,
      credential: password,
    } satisfies RTCIceServer;
  }

  throw new Error(
    `parseTurnServer: invalid method ${authMethod}`,
  );
}

export async function getIceServers(
  options: IceServerOptions,
): Promise<RTCIceServer[]> {
  const servers: RTCIceServer[] = [];

  for (const stun of options.stuns) {
    if (stun.trim().length === 0) continue;
    servers.push({ urls: stun });
  }

  for (const turn of options.turns) {
    const [error, server] = await catchError(
      parseTurnServer(turn),
    );
    if (error) {
      console.warn(
        "[IceServers] failed to load TURN server; skipping endpoint",
        { authMethod: turn.authMethod },
        error,
      );
      continue;
    }
    servers.push(server);
  }

  return servers;
}
