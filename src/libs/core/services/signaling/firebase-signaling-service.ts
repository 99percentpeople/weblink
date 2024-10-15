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
} from "../type";
import { SessionID } from "../../type";
import {
  decryptData,
  encryptData,
} from "../../utils/encrypt";

export class FirebaseSignalingService
  implements SignalingService
{
  private signalsRef;
  private _sessionId: string;
  private db = getDatabase(app);
  private _clientId: string;
  private _targetClientId: string;
  private unsubscribeCallbacks: Array<Unsubscribe> =
    new Array();
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

  listenForSignal(
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
    this.unsubscribeCallbacks.push(unsubscribe);
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
    this.unsubscribeCallbacks.forEach((cb) => cb());
    await this.clearSignals();
  }
}
