import {
  get,
  getDatabase,
  onChildAdded,
  onDisconnect,
  push,
  ref,
  remove,
} from "firebase/database";

import { app } from "@/libs/firebase";
import { v4 } from "uuid";
import {
  RawSignal,
  SendSignalOptions,
  ClientSignal,
  SignalingService,
  Unsubscribe,
  SignalingServiceEventMap,
} from "../type";
import { SessionID } from "../../type";
import {
  decryptData,
  encryptData,
} from "../../utils/encrypt";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";

export class FirebaseSignalingService
  implements SignalingService
{
  private eventEmitter =
    new MultiEventEmitter<SignalingServiceEventMap>();
  private signalsRef;
  private _sessionId: string;
  private db = getDatabase(app);
  private _clientId: string;
  private _targetClientId: string;
  private password: string | null = null;
  constructor(
    roomId: string,
    clientId: string,
    targetClientId: string,
    password: string | null,
  ) {
    this._sessionId = v4();
    this._targetClientId = targetClientId;
    this._clientId = clientId;
    this.signalsRef = ref(
      this.db,
      `rooms/${roomId}/signals`,
    );
    this.password = password;
    this.listenForSignal((signal) => {
      this.dispatchEvent("signal", signal);
    });
  }

  get sessionId(): SessionID {
    return this._sessionId;
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
    return this.eventEmitter.addEventListener(
      event,
      callback,
      options,
    );
  }

  removeEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      event,
      callback,
      options,
    );
  }

  private dispatchEvent<
    K extends keyof SignalingServiceEventMap,
  >(event: K, data: SignalingServiceEventMap[K]): boolean {
    return this.eventEmitter.dispatchEvent(event, data);
  }

  async sendSignal({
    type,
    data,
  }: RawSignal): Promise<void> {
    let sendData = data;
    if (this.password) {
      sendData = await encryptData(this.password, data);
    }

    const singnalRef = await push(this.signalsRef, {
      type: type,
      data: sendData,
      senderId: this._sessionId,
      clientId: this._clientId,
      targetClientId: this._targetClientId,
    });
    onDisconnect(singnalRef).remove();
  }

  private listenForSignal(
    callback: (signal: ClientSignal) => void,
  ) {
    const unsubscribe = onChildAdded(
      this.signalsRef,
      async (snapshot) => {
        const data = snapshot.val() as ClientSignal;
        if (!data) return;
        if (data.sessionId === this._sessionId) return;
        if (data.clientId !== this._targetClientId) return;
        if (
          data.targetClientId &&
          data.targetClientId !== this._clientId
        )
          return;

        if (this.password) {
          data.data = await decryptData(
            this.password,
            data.data,
          );
        }

        callback(data);
      },
    );
  }

  async getAllSignals(): Promise<ClientSignal[]> {
    const snapshot = await get(this.signalsRef);
    const signals: ClientSignal[] = [];

    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val() as ClientSignal;
      if (!data) return;
      if (data.sessionId === this._sessionId) return;
      if (data.clientId !== this._targetClientId) return;
      if (
        data.targetClientId &&
        data.targetClientId !== this._clientId
      )
        return;
      signals.push(data);
    });

    return signals;
  }

  async clearSignals() {
    const snapshot = await get(this.signalsRef);

    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val() as ClientSignal;
      if (
        data &&
        (data.sessionId === this._sessionId ||
          data.targetClientId === this._clientId)
      )
        remove(childSnapshot.ref);
    });
  }

  async destroy() {
    this.eventEmitter.clearListeners();
    await this.clearSignals();
  }
}
