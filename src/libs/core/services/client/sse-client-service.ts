import {
  ClientService,
  ClientServiceInitOptions,
  SignalingService,
} from "@/libs/core/services/type";
import { TransferClient } from "../../type";
import { SseSignalingService } from "../signaling/sse-signaling-service";
import { UpdateClientOptions } from "./firebase-client-service";

export class SseClientService implements ClientService {
  private serverUrl: string;
  private roomId: string;
  private client: TransferClient;
  private eventSource: EventSource | null = null;
  private password: string | null = null;
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
    const { roomId, client, password } = options;
    this.serverUrl = "/api";
    this.roomId = roomId;
    this.client = {
      ...client,
      createdAt: Date.now(),
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

  async createClient(): Promise<void> {
    const resp = await fetch(
      `${this.serverUrl}/rooms/${this.roomId}/clients`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...this.client,
          password: this.password,
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

  listenForJoin(
    callback: (client: TransferClient) => void,
  ): void {
    this.eventSource?.addEventListener(
      "client-joined",
      (e) => {
        callback(JSON.parse(e.data) as TransferClient);
      },
      {
        signal: this.controller.signal,
      },
    );
  }

  listenForLeave(
    callback: (client: TransferClient) => void,
  ): void {
    this.eventSource?.addEventListener(
      "client-left",
      (e) => {
        callback(JSON.parse(e.data) as TransferClient);
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
