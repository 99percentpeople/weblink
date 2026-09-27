// @vitest-environment jsdom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { STORAGE_KEYS } from "@/constants";

const disposers: Array<() => void> = [];

const bootProfile = async () => {
  const { createRoot } = await import("solid-js");
  const { initializeProfile } =
    await import("@/libs/state/profile-store");
  const { appState } =
    await import("@/libs/state/app-state");
  createRoot((dispose) => {
    disposers.push(dispose);
    initializeProfile();
  });
  return appState.profile;
};

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  localStorage.clear();
});

describe("client identity persistence", () => {
  it("generates short prefixed IDs for new profiles", async () => {
    const { getDefaultProfile } =
      await import("@/libs/state/profile-store");
    const first = getDefaultProfile().clientId;
    const second = getDefaultProfile().clientId;

    expect(first).toMatch(/^uid_[A-Za-z0-9_-]{16}$/);
    expect(second).toMatch(/^uid_[A-Za-z0-9_-]{16}$/);
    expect(second).not.toBe(first);
  });

  it("persists a new identity and reuses it on reload", async () => {
    const first = await bootProfile();
    const clientId = first.clientId;
    expect(clientId).toMatch(/^uid_[A-Za-z0-9_-]{16}$/);
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.profile)!,
      ).clientId,
    ).toBe(clientId);

    for (const dispose of disposers.splice(0)) dispose();
    vi.resetModules();

    expect((await bootProfile()).clientId).toBe(clientId);
  });

  it("preserves legacy IDs when loading a saved profile", async () => {
    const saved = {
      clientId: "a18f574d-63f6-442a-a9cf-cd482e0fc125",
      name: "Alice",
      roomId: "meeting",
      password: null,
      avatar: null,
      autoJoin: false,
      initalJoin: false,
    };
    localStorage.setItem(
      STORAGE_KEYS.profile,
      JSON.stringify(saved),
    );

    expect(await bootProfile()).toEqual(saved);
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.profile)!,
      ),
    ).toEqual(saved);
  });
});
