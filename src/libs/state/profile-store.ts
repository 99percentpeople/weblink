import { faker } from "@faker-js/faker";
import { createEffect } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { v4 } from "uuid";
import { STORAGE_KEYS } from "@/constants";
import type { ClientProfile } from "@/libs/domain/profile";
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
  const name = faker.person.lastName();
  return {
    roomId: faker.word.noun(),
    name,
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
