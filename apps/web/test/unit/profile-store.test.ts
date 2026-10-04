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

const bootProfile = async (
  getDeviceName?: () => Promise<string | null>,
) => {
  const { createRoot } = await import("solid-js");
  const { initializeProfile } =
    await import("@/libs/state/profile-store");
  const { appState } =
    await import("@/libs/state/app-state");
  let ready: Promise<void> | undefined;
  createRoot((dispose) => {
    disposers.push(dispose);
    ready = initializeProfile(getDeviceName);
  });
  await ready;
  return appState.profile;
};

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  localStorage.clear();
  vi.restoreAllMocks();
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

    expect(await bootProfile()).toEqual(first);
  });

  it("allows short repeated display names while keeping room and client IDs independent", async () => {
    const { getDefaultProfile } =
      await import("@/libs/state/profile-store");
    const getRandomValues =
      crypto.getRandomValues.bind(crypto);
    let suffix = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      (array) => {
        if (array instanceof Uint32Array) {
          // Repeat the same words while varying only the random room suffix.
          array.fill(0);
          array[array.length - 1] = suffix++;
          return array;
        }
        return getRandomValues(array);
      },
    );
    const profiles = Array.from({ length: 20 }, () =>
      getDefaultProfile(),
    );

    for (const profile of profiles) {
      expect(profile.name).toMatch(
        /^[a-z]{3,5} [a-z]{3,5}$/,
      );
      expect(profile.roomId).toMatch(
        /^[a-z]{3,5}-[a-z]{3,5}-[0-9]{3}$/,
      );
      expect(profile.name).not.toBe(profile.roomId);
      expect(profile.password).toBeNull();
    }
    expect(
      new Set(profiles.map(({ roomId }) => roomId)).size,
    ).toBe(profiles.length);
    expect(
      new Set(profiles.map(({ name }) => name)).size,
    ).toBe(1);
    expect(
      new Set(profiles.map(({ clientId }) => clientId))
        .size,
    ).toBe(profiles.length);
  });

  it("uses and persists the device name only when creating a profile", async () => {
    const readDeviceName = vi
      .fn()
      .mockResolvedValue("  Workstation  ");
    const profile = await bootProfile(readDeviceName);
    expect(profile.name).toBe("Workstation");
    expect(readDeviceName).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.profile)!,
      ).name,
    ).toBe("Workstation");

    for (const dispose of disposers.splice(0)) dispose();
    vi.resetModules();
    readDeviceName.mockClear();
    readDeviceName.mockResolvedValue("Renamed device");
    expect((await bootProfile(readDeviceName)).name).toBe(
      "Workstation",
    );
    expect(readDeviceName).not.toHaveBeenCalled();
  });

  it.each([null, "   "])(
    "keeps combined defaults when the device name is %s",
    async (name) => {
      const profile = await bootProfile(async () => name);
      expect(profile.name).toMatch(
        /^[a-z]{3,5} [a-z]{3,5}$/,
      );
    },
  );

  it("keeps the fallback when device access fails", async () => {
    const profile = await bootProfile(async () => {
      throw new Error("unavailable");
    });
    expect(profile.name).toMatch(/^[a-z]{3,5} [a-z]{3,5}$/);
  });

  it("does not overwrite an edit made while the device lookup is pending", async () => {
    let resolveName!: (name: string) => void;
    const readDeviceName = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveName = resolve;
        }),
    );
    const ready = bootProfile(readDeviceName);
    await vi.waitFor(() =>
      expect(readDeviceName).toHaveBeenCalledOnce(),
    );
    const { setAppState } =
      await import("@/libs/state/app-state");
    setAppState("profile", "name", "My chosen name");
    resolveName("Device name");
    expect((await ready).name).toBe("My chosen name");
  });

  it("ignores a device lookup after its application scope is disposed", async () => {
    let resolveName!: (name: string) => void;
    const readDeviceName = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveName = resolve;
        }),
    );
    const ready = bootProfile(readDeviceName);
    await vi.waitFor(() =>
      expect(readDeviceName).toHaveBeenCalledOnce(),
    );
    for (const dispose of disposers.splice(0)) dispose();
    resolveName("Device name");
    expect((await ready).name).toMatch(
      /^[a-z]{3,5} [a-z]{3,5}$/,
    );
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

    const readDeviceName = vi
      .fn()
      .mockResolvedValue("Device name");
    expect(await bootProfile(readDeviceName)).toEqual(
      saved,
    );
    expect(readDeviceName).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.profile)!,
      ),
    ).toEqual(saved);
  });
});
