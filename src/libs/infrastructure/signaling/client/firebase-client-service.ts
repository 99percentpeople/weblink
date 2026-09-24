import {
  child,
  DatabaseReference,
  get,
  getDatabase,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  push,
  ref,
  remove,
  update,
} from "firebase/database";
import { app } from "@/libs/infrastructure/firebase";
import type {
  ClientPresence,
  ClientService,
  ClientServiceEventMap,
  ClientServiceInitOptions,
  TransferClient,
  UpdateClientOptions,
} from "@/libs/domain/client";
import type { SignalingService } from "@/libs/domain/signaling";

type Unsubscribe = () => void;
import { FirebaseSignalingService } from "../transport/firebase-signaling-service";
import {
  createClientPresence,
  hydrateClientPresence,
} from "./client-presence";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  comparePasswordHash,
  hashPassword,
} from "@/libs/domain/utils/encrypt/e2e";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";

export class FirebaseClientService implements ClientService {
  private eventEmitter =
    new MultiEventEmitter<ClientServiceEventMap>();
  private roomId: string;
  private db = getDatabase(app);
  private roomRef: DatabaseReference;

  private client: TransferClient;
  private clientRef: DatabaseReference | null = null;
  private password: string | null = null;

  private singlingServices: Map<
    string,
    FirebaseSignalingService
  >;
  private unsubscribeCallbacks: Array<Unsubscribe> =
    new Array();

  get info() {
    return this.client;
  }

  private readonly onNotice: ClientServiceInitOptions["onNotice"];

  constructor({
    onNotice,
    roomId,
    password,
    client,
  }: ClientServiceInitOptions) {
    this.onNotice = onNotice;
    this.client = { ...client, createdAt: Date.now() };
    this.roomId = roomId;
    this.roomRef = ref(this.db, `rooms/${roomId}`);

    this.singlingServices = new Map();
    if (password) this.password = password;
  }

  private dispatchEvent<
    K extends keyof ClientServiceEventMap,
  >(event: K, data: ClientServiceEventMap[K]) {
    return this.eventEmitter.dispatchEvent(event, data);
  }

  addEventListener<K extends keyof ClientServiceEventMap>(
    event: K,
    callback: EventHandler<ClientServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      event,
      callback,
      options,
    );
  }

  removeEventListener<
    K extends keyof ClientServiceEventMap,
  >(
    event: K,
    callback: EventHandler<ClientServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      event,
      callback,
      options,
    );
  }

  private async setupRoom() {
    await signInAnonymously(getAuth(app));

    const roomSnapshot = await get(this.roomRef);
    const roomData = roomSnapshot.val();
    let passwordHash: string | null = null;
    if (this.password) {
      passwordHash = await hashPassword(
        this.password,
      ).catch((error) => {
        console.error(error);
        this.onNotice?.("password-hash-failed");
        this.password = null;
        return null;
      });
    }
    if (!roomData && passwordHash) {
      await update(this.roomRef, { passwordHash });
      await onDisconnect(this.roomRef).update({
        passwordHash: null,
      });
    }

    return {
      passwordHash,
    };
  }

  async createClient() {
    this.dispatchEvent("statuschange", "connecting");

    const roomData = await this.setupRoom();

    if (roomData.passwordHash) {
      if (!this.password) {
        this.close();
        throw new Error("password required");
      }

      const passwordMatch = await comparePasswordHash(
        this.password,
        roomData.passwordHash,
      );

      if (!passwordMatch) {
        this.close();
        throw new Error("incorrect password");
      }
    } else {
      this.password = null;
      this.onNotice?.("room-unprotected");
    }

    const clientsRef = child(this.roomRef, "/clients");
    const snapshot = await get(clientsRef);
    let client: ClientPresence | null = null;
    snapshot.forEach((child) => {
      const data = child.val() as ClientPresence;
      if (data.clientId === this.client.clientId) {
        client = data;
      }
    });

    if (!client) {
      const clientRef = await push(
        clientsRef,
        createClientPresence(this.client),
      );
      onDisconnect(clientRef).remove();
      this.clientRef = clientRef;
    }
    this.dispatchEvent("statuschange", "connected");
    console.info(
      "[FirebaseClientService] room signaling ready",
      {
        clientId: this.client.clientId,
      },
    );
  }

  async updateClient(options: UpdateClientOptions) {
    this.client.name = options.name ?? this.client.name;
    this.client.avatar =
      options.avatar === undefined
        ? this.client.avatar
        : options.avatar;
  }

  createSender(
    targetClientId: string,
  ): SignalingService | null {
    const service =
      this.singlingServices.get(targetClientId);
    if (service) {
      console.warn(
        `sender to remote client: ${targetClientId} already exists`,
      );
      return null;
    }
    const newService = new FirebaseSignalingService(
      this.roomId,
      this.client.clientId,
      targetClientId,
      this.password,
    );
    console.debug(
      `[FirebaseClientService] create sender to peer ${targetClientId}`,
    );
    this.singlingServices.set(targetClientId, newService);
    return newService;
  }

  removeSender(targetClientId: string) {
    const sender =
      this.singlingServices.get(targetClientId);
    if (sender) {
      sender.close();
      this.singlingServices.delete(targetClientId);
    }
  }

  async getJoinedClients() {
    const clients: TransferClient[] = [];
    const clientsRef = child(this.roomRef, "/clients");
    const snapshot = await get(clientsRef);
    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val() as ClientPresence;
      if (!data) return;
      if (data.clientId === this.client.clientId) return;
      clients.push(hydrateClientPresence(data));
    });
    return clients;
  }

  listenForJoin(
    callback: (client: TransferClient) => void,
  ) {
    const clientsRef = child(this.roomRef, "/clients");
    const unsubscribe = onChildAdded(
      clientsRef,
      (snapshot) => {
        const data = snapshot.val() as ClientPresence;
        if (!data) return;
        if (data.clientId === this.client.clientId) return;

        callback(hydrateClientPresence(data));
      },
    );

    this.unsubscribeCallbacks.push(unsubscribe);
  }

  listenForLeave(
    callback: (client: TransferClient) => void,
  ) {
    const clientsRef = child(this.roomRef, "/clients");
    const unsubscribe = onChildRemoved(
      clientsRef,
      (snapshot) => {
        const data = snapshot.val() as ClientPresence;
        if (!data) return;
        if (data.clientId === this.client.clientId) return;
        callback(hydrateClientPresence(data));
      },
    );
    this.unsubscribeCallbacks.push(unsubscribe);
  }

  async close() {
    this.singlingServices.forEach((sender) =>
      sender.close(),
    );
    this.unsubscribeCallbacks.map((cb) => cb());
    const clientsRef = child(this.roomRef, "/clients");
    const snapshot = await get(clientsRef);

    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val();
      if (data && data.clientId === this.client.clientId)
        remove(childSnapshot.ref);
    });

    this.dispatchEvent("statuschange", "disconnected");
  }
}
