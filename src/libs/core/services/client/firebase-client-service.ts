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
  TransferClient,
  Unsubscribe,
  type ClientPresence,
  type UpdateClientOptions,
} from "../type";
import { FirebaseSignalingService } from "../signaling/firebase-signaling-service";
import {
  createClientPresence,
  hydrateClientPresence,
} from "./client-presence";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  comparePasswordHash,
  hashPassword,
} from "../../utils/encrypt/e2e";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";
import { toast } from "solid-sonner";

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
        toast.error(
          `failed to hash password: ${error.message}`,
        );
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

  private setupDisconnectListener() {
    const connectedRef = ref(this.db, ".info/connected");

    onValue(connectedRef, (snap) => {
      console.log("firebase connection", snap.val());
    });
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
      toast.warning("the room is not password protected");
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
      console.log(
        `getJoinedClients ${data.clientId}`,
        data,
      );
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
        console.log(`client ${data.clientId} leave`);
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
