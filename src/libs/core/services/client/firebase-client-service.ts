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
  onValue,
} from "firebase/database";
import { app } from "@/libs/firebase";
import {
  ClientService,
  ClientServiceEventMap,
  ClientServiceInitOptions,
  SignalingService,
  Unsubscribe,
} from "../type";
import { Client, TransferClient } from "../../type";
import { FirebaseSignalingService } from "../signaling/firebase-signaling-service";
import {
  comparePasswordHash,
  hashPassword,
} from "../../utils/encrypt";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";
import { toast } from "solid-sonner";

export interface UpdateClientOptions {
  name?: string;
}

export class FirebaseClientService
  implements ClientService
{
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

  constructor({
    roomId,
    password,
    client,
  }: ClientServiceInitOptions) {
    this.client = { ...client, createdAt: Date.now() };
    this.roomId = roomId;
    this.roomRef = ref(this.db, `rooms/${roomId}`);

    this.singlingServices = new Map();
    if (password) this.password = password;

    this.setRoomPassword();
    this.setupDisconnectListener();
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

  private async setRoomPassword() {
    if (!this.password) return;
    const passwordHash = await hashPassword(this.password);
    const roomSnapshot = await get(this.roomRef);
    const roomData = roomSnapshot.val();
    if (!roomData) {
      await update(this.roomRef, { passwordHash });
      await onDisconnect(this.roomRef).update({
        passwordHash: null,
      });
    }
  }

  private setupDisconnectListener() {
    const connectedRef = ref(this.db, ".info/connected");

    onValue(connectedRef, (snap) => {
      console.log("firebase connection", snap.val());
    });
  }

  async createClient() {
    this.dispatchEvent("status-change", "connecting");

    const roomSnapshot = await get(this.roomRef);
    const roomData = roomSnapshot.val();

    if (roomData && roomData.passwordHash) {
      if (!this.password) {
        this.destroy();
        throw new Error("password required");
      }

      const passwordMatch = await comparePasswordHash(
        this.password,
        roomData.passwordHash,
      );

      if (!passwordMatch) {
        this.destroy();
        throw new Error("incorrect password");
      }
    } else {
      this.password = null;
      toast.error("the room is not password protected");
    }

    const clientsRef = child(this.roomRef, "/clients");
    const snapshot = await get(clientsRef);
    let client: Client | null = null;
    snapshot.forEach((child) => {
      const data = child.val() as Client;
      if (data.clientId === this.client.clientId) {
        client = data;
      }
    });

    if (!client) {
      const clientRef = await push(clientsRef, this.client);
      onDisconnect(clientRef).remove();
      this.clientRef = clientRef;
    }
    this.dispatchEvent("status-change", "connected");
  }

  async updateClient(options: UpdateClientOptions) {
    if (!this.clientRef) {
      console.warn(
        `client ${this.client.clientId} not publish in database`,
      );
      return;
    }

    this.client.name = options.name ?? this.client.name;

    await update(this.clientRef, this.client);
  }

  getSender(targetClientId: string): SignalingService {
    const service =
      this.singlingServices.get(targetClientId);
    if (service) return service;
    const newService = new FirebaseSignalingService(
      this.roomId,
      this.client.clientId,
      targetClientId,
      this.password,
    );
    console.log(
      `create sender to remote client: ${targetClientId}`,
    );
    this.singlingServices.set(targetClientId, newService);
    return newService;
  }

  removeSender(targetClientId: string) {
    const sender =
      this.singlingServices.get(targetClientId);
    if (sender) {
      sender.destroy();
      this.singlingServices.delete(targetClientId);
    }
  }

  async getJoinedClients() {
    const clients: Client[] = [];
    const clientsRef = child(this.roomRef, "/clients");
    const snapshot = await get(clientsRef);
    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val() as Client;
      if (!data) return;
      if (data.clientId === this.client.clientId) return;
      console.log(
        `getJoinedClients ${data.clientId}`,
        data,
      );
      clients.push(data);
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
        const data = snapshot.val() as TransferClient;
        if (!data) return;
        console.log(`on child added`, data);

        if (data.clientId === this.client.clientId) return;
        callback(data);
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
        const data = snapshot.val() as TransferClient;
        if (!data) return;
        if (data.clientId === this.client.clientId) return;
        console.log(`client ${data.clientId} leave`);
        callback(data);
      },
    );
    this.unsubscribeCallbacks.push(unsubscribe);
  }

  async destroy() {
    this.singlingServices.forEach((sender) =>
      sender.destroy(),
    );
    this.unsubscribeCallbacks.map((cb) => cb());
    const clientsRef = child(this.roomRef, "/clients");
    const snapshot = await get(clientsRef);

    snapshot.forEach((childSnapshot) => {
      const data = childSnapshot.val();
      if (data && data.clientId === this.client.clientId)
        remove(childSnapshot.ref);
    });

    this.dispatchEvent("status-change", "disconnected");
  }
}
