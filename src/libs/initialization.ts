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

let initPromise: Promise<void> | null = null;

export function createInitialization() {
  if (initPromise) return initPromise;

  setAppState(reconcile(createInitialAppState()));

  initializeAppOptions();
  initializeProfile();

  createTransferManager();
  createSessionService();
  createMessageStores();
  createCacheManager();

  initPromise = cacheManager
    .initialize()
    .then(() => undefined);

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
