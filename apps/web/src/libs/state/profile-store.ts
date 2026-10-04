import { createEffect, onCleanup } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { STORAGE_KEYS } from "@/constants";
import { createClientId } from "@/libs/domain/ids";
import {
  MAX_PEER_PROFILE_NAME_LENGTH,
  type ClientProfile,
} from "@/libs/domain/profile";
import { createDefaultProfileNames } from "@/libs/domain/profile-defaults";
import { appState, setAppState } from "./app-state";

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

export const getDefaultProfile = (): ClientProfile => {
  return {
    ...createDefaultProfileNames(),
    clientId: createClientId(),
    password: null,
    avatar: null,
    autoJoin: false,
    initalJoin: true,
  };
};

let profileInitialized = false;

export function initializeProfile(
  getDeviceName?: () => Promise<string | null>,
): Promise<void> {
  if (profileInitialized) return Promise.resolve();
  profileInitialized = true;
  let defaults: ClientProfile | undefined;
  const createProfile = () => {
    defaults = getDefaultProfile();
    setAppState("profile", defaults);
  };

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
        createProfile();
      }
    } else {
      createProfile();
    }
  } else {
    createProfile();
  }

  createEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      STORAGE_KEYS.profile,
      JSON.stringify(appState.profile),
    );
  });

  if (!defaults || !getDeviceName) return Promise.resolve();
  const initialName = defaults.name;
  const initialClientId = defaults.clientId;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return Promise.resolve()
    .then(getDeviceName)
    .then((deviceName) => {
      const name = deviceName
        ?.trim()
        .slice(0, MAX_PEER_PROFILE_NAME_LENGTH);
      if (
        name &&
        !disposed &&
        appState.profile.clientId === initialClientId &&
        appState.profile.name === initialName
      ) {
        setAppState("profile", "name", name);
      }
    })
    .catch(() => {
      // Device metadata is optional; keep the persisted random defaults on failure.
    });
}

export const clientProfile = appState.profile;

export const setClientProfile: SetStoreFunction<ClientProfile> =
  ((...args: any[]) =>
    (setAppState as any)("profile", ...args)) as any;
