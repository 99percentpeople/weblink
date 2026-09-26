interface TurnCredentials {
  iceServers: RTCIceServer[];
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 5 * 60_000;

export function getTurnCredentialsUrl(
  websocketUrl: string | undefined,
): string | undefined {
  if (!websocketUrl) return;
  try {
    const url = new URL(websocketUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:")
      return;
    url.protocol =
      url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/turn-credentials";
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return;
  }
}

function parseCredentials(
  data: unknown,
  now: number,
): TurnCredentials {
  if (
    !data ||
    typeof data !== "object" ||
    !("expiresAt" in data) ||
    typeof data.expiresAt !== "number" ||
    !Number.isFinite(data.expiresAt) ||
    data.expiresAt <= now ||
    !("iceServers" in data) ||
    !Array.isArray(data.iceServers) ||
    data.iceServers.length === 0
  ) {
    throw new Error("Invalid TURN credentials response");
  }
  let hasTurn = false;
  const iceServers = data.iceServers.map(
    (server: unknown): RTCIceServer => {
      if (
        !server ||
        typeof server !== "object" ||
        !("urls" in server)
      ) {
        throw new Error("Invalid ICE server");
      }
      const urls =
        typeof server.urls === "string"
          ? [server.urls]
          : server.urls;
      if (
        !Array.isArray(urls) ||
        urls.length === 0 ||
        !urls.every(
          (url: unknown) =>
            typeof url === "string" &&
            /^(stun|turn)s?:\S+$/.test(url),
        )
      )
        throw new Error("Invalid ICE URLs");
      if (
        urls.some((url: string) => /^turns?:/.test(url))
      ) {
        if (
          !("username" in server) ||
          typeof server.username !== "string" ||
          !server.username ||
          !("credential" in server) ||
          typeof server.credential !== "string" ||
          !server.credential
        ) {
          throw new Error("Invalid TURN credentials");
        }
        hasTurn = true;
        return {
          urls: [...urls],
          username: server.username,
          credential: server.credential,
        };
      }
      return { urls: [...urls] };
    },
  );
  if (!hasTurn) throw new Error("Missing TURN server");
  return { iceServers, expiresAt: data.expiresAt };
}

/** Per-app memory cache. Never persist or serialize temporary credentials. */
export class TurnCredentialsClient {
  private cached?: TurnCredentials;
  private pending?: Promise<TurnCredentials>;

  constructor(
    private readonly endpoint: string,
    private readonly options: {
      fetch?: typeof fetch;
      now?: () => number;
    } = {},
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  async getIceServers(): Promise<RTCIceServer[]> {
    if (
      this.cached &&
      this.cached.expiresAt - this.now() > REFRESH_MARGIN_MS
    ) {
      return structuredClone(this.cached.iceServers);
    }
    if (!this.pending) {
      this.pending = this.request().finally(() => {
        this.pending = undefined;
      });
    }
    try {
      const credentials = await this.pending;
      return structuredClone(credentials.iceServers);
    } catch (error) {
      // A failed early refresh may still use the unexpired previous credentials.
      if (
        this.cached &&
        this.cached.expiresAt > this.now()
      ) {
        return structuredClone(this.cached.iceServers);
      }
      throw error;
    }
  }

  private async request(): Promise<TurnCredentials> {
    const response = await (this.options.fetch ?? fetch)(
      this.endpoint,
      {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `TURN credentials request failed: ${response.status}`,
      );
    }
    this.cached = parseCredentials(
      await response.json(),
      this.now(),
    );
    return this.cached;
  }
}
