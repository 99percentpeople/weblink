import {
  get,
  getDatabase,
  onChildAdded,
  onDisconnect,
  push,
  ref,
  remove,
} from "firebase/database";

import { app } from "@/libs/infrastructure/firebase";
import type {
  RawSignal,
  ClientSignal,
  SignalingService,
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "@/libs/domain/signaling";

type Unsubscribe = () => void;
import {
  decryptData,
  encryptData,
} from "@/libs/domain/utils/encrypt/e2e";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";

export class FirebaseSignalingService implements SignalingService {
  private eventEmitter =
    new MultiEventEmitter<SignalingServiceEventMap>();
  private signalsRef;
  private db = getDatabase(app);
  private _clientId: string;
  private _targetClientId: string;
  private password: string | null = null;
  private _status: SignalingServiceStatus = "init";
  private listeners: Record<
    string,
    {
      callback: string;
      unsubscribe: Unsubscribe;
    }[]
  > = {};

  constructor(
    roomId: string,
    clientId: string,
    targetClientId: string,
    password: string | null,
  ) {
    this._targetClientId = targetClientId;
    this._clientId = clientId;
    this.signalsRef = ref(
      this.db,
      `rooms/${roomId}/signals`,
    );
    this.password = password;
  }

  get clientId(): string {
    return this._clientId;
  }

  get targetClientId(): string {
    return this._targetClientId;
  }

  addEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (event === "signal") {
      const unsubscribe = this.listenForSignal((signal) => {
        if (typeof options !== "boolean") {
          if (options?.once) {
            unsubscribe();
          }
          if (options?.signal) {
            options.signal.addEventListener("abort", () => {
              unsubscribe();
            });
          }
        }
        callback(
          new CustomEvent(event, {
            detail: signal,
          }) as CustomEvent<SignalingServiceEventMap[K]>,
        );
      });
      this.listeners[event] = [
        ...(this.listeners[event] || []),
        { callback: callback.toString(), unsubscribe },
      ];
    } else {
      this.eventEmitter.addEventListener(
        event,
        callback,
        options,
      );
    }
  }

  removeEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    if (event === "signal") {
      const unsubscribe = this.listeners[event].find(
        (listener) =>
          listener.callback === callback.toString(),
      )?.unsubscribe;
      if (unsubscribe) {
        unsubscribe();
        this.listeners[event] = this.listeners[
          event
        ].filter(
          (listener) =>
            listener.callback !== callback.toString(),
        );
      }
    } else {
      this.eventEmitter.removeEventListener(
        event,
        callback,
        options,
      );
    }
  }

  private dispatchEvent<
    K extends keyof SignalingServiceEventMap,
  >(event: K, data: SignalingServiceEventMap[K]) {
    this.eventEmitter.dispatchEvent(event, data);
  }

  get status(): SignalingServiceStatus {
    return this._status;
  }

  private setStatus(status: SignalingServiceStatus) {
    this._status = status;
    if (status !== "init") {
      this.dispatchEvent("statuschange", status);
    }
  }

  async sendSignal({
    type,
    data,
  }: RawSignal): Promise<void> {
    let sendData = data;
    if (this.password) {
      sendData = await encryptData(this.password, sendData);
    }

    const singnalRef = await push(this.signalsRef, {
      type: type,
      data: sendData,
      clientId: this._clientId,
      targetClientId: this._targetClientId,
    });
    onDisconnect(singnalRef).remove();
  }

  private listenForSignal(
    callback: (signal: ClientSignal) => void,
  ) {
    this.setStatus("connected");
    return onChildAdded(
      this.signalsRef,
      async (snapshot) => {
        const message = snapshot.val() as ClientSignal;
        if (!message) return;
        if (message.clientId === this._clientId) return;
        if (message.clientId !== this._targetClientId)
          return;
        if (
          message.targetClientId &&
          message.targetClientId !== this._clientId
        )
          return;
        remove(snapshot.ref);
        if (this.password) {
          message.data = await decryptData(
            this.password,
            message.data,
          );
        }
        message.data = JSON.parse(message.data);
        callback(message);
      },
    );
  }

  async clearSignals() {
    this.setStatus("disconnected");
    const snapshot = await get(this.signalsRef);

    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val() as ClientSignal;
      if (data && data.targetClientId === this._clientId)
        remove(childSnapshot.ref);
    });
  }

  async close() {
    this.setStatus("closed");
    await this.clearSignals();
    Object.values(this.listeners).forEach((listeners) => {
      listeners.forEach((listener) => {
        listener.unsubscribe();
      });
    });
  }
}
