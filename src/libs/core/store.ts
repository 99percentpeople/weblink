import { faker } from "@faker-js/faker";
import { v4 } from "uuid";
import { generateHMAC } from "./utils/encrypt/hmac";
import type { TurnServerOptions } from "@/options";
import { STORAGE_KEYS } from "@/constants";
import { catchError } from "../catch";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { SetStoreFunction } from "solid-js/store";
import { createEffect } from "solid-js";
import type { ClientProfile } from "./profile";

/**
 * parse turn server options to RTCIceServer
 * @param turn - turn server options
 * @returns RTCIceServer
 * @throws Error
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
      credential: credential,
    } satisfies RTCIceServer;
  } else if (authMethod === "longterm") {
    return {
      urls: turn.url,
      username: username,
      credential: password,
    } satisfies RTCIceServer;
  } else if (authMethod === "cloudflare") {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${username}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${password}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ttl: 86400,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `parseTurnServer: cloudflare error response: ${response.status}`,
      );
    }

    const iceServers = (await response
      .json()
      .then((data) => data.iceServers)) as RTCIceServer;

    console.log("cloudflare iceServers:", iceServers);
    return iceServers satisfies RTCIceServer;
  } else {
    throw new Error(
      `parseTurnServer: invalid method ${authMethod}`,
    );
  }
}

export async function getIceServers() {
  const servers: RTCIceServer[] = [];
  for (const stun of appState.options.servers.stuns) {
    if (stun.trim().length === 0) continue;
    servers.push({
      urls: stun,
    });
  }
  if (appState.options.servers.turns)
    for (const turn of appState.options.servers.turns) {
      const [error, server] = await catchError(
        parseTurnServer(turn),
      );
      if (error) {
        console.error(error);
        continue;
      }

      servers.push(server);
    }

  return servers;
}

const LEGACY_DICEBEAR_INITIALS_PREFIX =
  "https://api.dicebear.com/9.x/initials/svg";

export const normalizeStoredProfile = (
  profile: ClientProfile,
): ClientProfile => ({
  ...profile,
  avatar:
    typeof profile.avatar === "string" &&
    profile.avatar.startsWith(
      LEGACY_DICEBEAR_INITIALS_PREFIX,
    )
      ? null
      : profile.avatar,
});

export const getDefaultProfile = () => {
  const name = faker.person.lastName();
  return {
    roomId: faker.word.noun(),
    name: name,
    clientId: v4(),
    password: null,
    avatar: null,
    autoJoin: false,
    initalJoin: true,
  };
};

let profileInitialized = false;

export function initializeProfile() {
  if (profileInitialized) return;
  profileInitialized = true;

  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem(STORAGE_KEYS.profile);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ClientProfile;
        setAppState(
          "profile",
          normalizeStoredProfile(parsed),
        );
      } catch (err) {
        console.warn(
          "[initializeProfile] invalid profile in localStorage",
          err,
        );
        setAppState("profile", getDefaultProfile());
      }
    } else {
      setAppState("profile", getDefaultProfile());
    }
  } else {
    setAppState("profile", getDefaultProfile());
  }

  createEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      STORAGE_KEYS.profile,
      JSON.stringify(appState.profile),
    );
  });
}

export const clientProfile = appState.profile;

export const setClientProfile: SetStoreFunction<ClientProfile> =
  ((...args: any[]) =>
    (setAppState as any)("profile", ...args)) as any;
