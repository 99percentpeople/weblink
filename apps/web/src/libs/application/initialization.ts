import { reconcile } from "solid-js/store";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { initializeProfile } from "@/libs/state/profile-store";
import { initializeAppOptions } from "@/options";
import {
  createCacheManager,
  cacheManager,
} from "@/libs/application/cache-service";
import { createSessionService } from "@/libs/application/session-service";
import { createTransferManager } from "@/libs/application/transfer/transfer-service";
import { createRtcService } from "@/libs/application/rtc/rtc-service";
import { createRtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import { createMessageStores } from "@/libs/application/messaging/message-store";
import { IndexedDbMessageRepository } from "@/libs/infrastructure/storage/indexeddb-message-repository";

let initPromise: Promise<void> | null = null;

export function createInitialization(
  getDeviceName?: () => Promise<string | null>,
) {
  if (initPromise) return initPromise;

  setAppState(reconcile(createInitialAppState()));

  initializeAppOptions();
  const profileReady = initializeProfile(getDeviceName);

  createTransferManager();
  createSessionService();
  const messageStores = createMessageStores(
    new IndexedDbMessageRepository(),
  );
  createCacheManager();

  initPromise = Promise.all([
    profileReady,
    cacheManager.initialize(),
    messageStores.initialize(),
  ]).then(() => undefined);

  return initPromise;
}

export const services = {
  get cacheManager() {
    return createCacheManager();
  },
  get sessionService() {
    return createSessionService();
  },
  get transferManager() {
    return createTransferManager();
  },
  get messageStores() {
    return createMessageStores();
  },
  get rtcService() {
    return createRtcService();
  },
  get rtcProtocol() {
    return createRtcProtocol();
  },
};
