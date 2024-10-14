import {
  ClientService,
  ClientServiceInitOptions,
  SignalingService,
} from "@/libs/core/services/type";
import { Client } from "../../type";
import { SseSignalingService } from "../signaling/sse-signaling-service";
import { UpdateClientOptions } from "./firebase-client-service";

export class SseClientService implements ClientService {
  private serverUrl: string;
  private roomId: string;
  private client: Client;
  private eventSource: EventSource | null = null;
  private signalingServices: Map<
    string,
    SseSignalingService
  > = new Map();

  private controller: AbortController =
    new AbortController();

  get info() {
    return this.client;
  }

  constructor(options: ClientServiceInitOptions) {
    const { roomId, clientId, name, password } = options;
    this.serverUrl = "/api";
    this.roomId = roomId;
    this.client = {
      clientId: clientId,
      createAt: Date.now(),
      name: name,
    };
    if (password) {
      this.setRoomPassword(password);
    }
  }

  private async setRoomPassword(password: string) {
    const resp = await fetch(`${this.serverUrl}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: this.roomId,
        password: password,
      }),
    });

    if (!resp.ok) {
      console.warn(await resp.text());
    }
  }

  async createClient(password?: string): Promise<void> {
    const resp = await fetch(
      `${this.serverUrl}/rooms/${this.roomId}/clients`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...this.client,
          password,
        }),
      },
    );
    if (!resp.ok) {
      throw Error(
        `createClient error: ${await resp.text()}`,
      );
    }

    // Start listening to SSE events
    this.eventSource = new EventSource(
      `${this.serverUrl}/rooms/${this.roomId}/clients/${this.client.clientId}/events`,
    );
  }

  async updateClient(
    options: UpdateClientOptions,
  ): Promise<void> {
    const updatedClient = {
      ...this.client,
      ...options,
      createAt: Date.now(),
    };
    await fetch(
      `${this.serverUrl}/rooms/${this.roomId}/clients/${this.client.clientId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedClient),
      },
    );
    this.client = updatedClient;
  }

  getSender(targetClientId: string): SignalingService {
    if (this.signalingServices.has(targetClientId)) {
      return this.signalingServices.get(targetClientId)!;
    }
    const signalingService = new SseSignalingService({
      serverUrl: this.serverUrl,
      roomId: this.roomId,
      clientId: this.client.clientId,
      targetClientId,
    });
    this.signalingServices.set(
      targetClientId,
      signalingService,
    );
    return signalingService;
  }

  removeSender(targetClientId: string): void {
    const service =
      this.signalingServices.get(targetClientId);
    if (service) {
      service.destroy();
      this.signalingServices.delete(targetClientId);
    }
  }

  listenForJoin(callback: (client: Client) => void): void {
    this.eventSource?.addEventListener(
      "client-joined",
      (e) => {
        callback(JSON.parse(e.data) as Client);
      },
      {
        signal: this.controller.signal,
      },
    );
  }

  listenForLeave(callback: (client: Client) => void): void {
    this.eventSource?.addEventListener(
      "client-left",
      (e) => {
        callback(JSON.parse(e.data) as Client);
      },
      {
        signal: this.controller.signal,
      },
    );
  }

  destroy(): void {
    this.eventSource?.close();
    this.signalingServices.forEach((service) =>
      service.destroy(),
    );
    this.controller.abort();
  }
}
