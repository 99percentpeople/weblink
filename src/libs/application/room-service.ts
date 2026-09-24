import type {
  Client,
  ClientService,
  ClientServiceInitOptions,
  TransferClient,
} from "@/libs/domain/client";
import type { PeerSession } from "@/libs/domain/session";
import { catchError } from "@/libs/catch";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { PeerProfileService } from "./peer-profile-service";
import type { RtcService } from "./rtc/rtc-service";
import type { SessionService } from "./session-service";

type SessionCoordinator = Pick<
  SessionService,
  | "sessions"
  | "clientService"
  | "setClientService"
  | "addClient"
  | "removeSession"
  | "destoryAllSession"
>;

type RtcCoordinator = Pick<
  RtcService,
  "bindSession" | "unbindSession" | "unbindAllSessions"
>;

type ProfileCoordinator = Pick<
  PeerProfileService,
  "bindSession" | "unbindSession" | "unbindAllSessions"
>;

type MessageContacts = {
  setClient(client: Client): void;
};

export interface RoomServiceOptions {
  sessions: SessionCoordinator;
  rtc: RtcCoordinator;
  profiles: ProfileCoordinator;
  messages: MessageContacts;
  createClientService(
    options: ClientServiceInitOptions,
  ): Promise<ClientService>;
  getLocalStream(): MediaStream | null;
  onLeaving?(): void;
  onMemberJoined?(roomId: string, client: Client): void;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export class RoomService {
  private generation = 0;
  private pendingJoin: Promise<void> | null = null;
  private boundService: ClientService | null = null;
  private boundGeneration = -1;
  private activeProfile: ClientServiceInitOptions | null =
    null;
  private disposed = false;

  constructor(
    private readonly options: RoomServiceOptions,
  ) {}

  private isGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isServiceCurrent(
    service: ClientService,
    generation: number,
  ): boolean {
    return (
      this.isGenerationCurrent(generation) &&
      this.options.sessions.clientService === service
    );
  }

  private bindClientService(
    service: ClientService,
    generation: number,
    roomId: string,
  ): void {
    if (
      this.boundService === service &&
      this.boundGeneration === generation
    ) {
      return;
    }

    this.boundService = service;
    this.boundGeneration = generation;

    service.listenForJoin((client) => {
      void this.handleClientJoin(
        service,
        generation,
        roomId,
        client,
      );
    });

    service.listenForLeave((client) => {
      if (!this.isServiceCurrent(service, generation)) {
        return;
      }

      console.log(`client ${client.clientId} leave`);
      this.options.profiles.unbindSession(client.clientId);
      this.options.sessions.removeSession(client.clientId);
      this.options.rtc.unbindSession(client.clientId);
    });
  }

  private async handleClientJoin(
    service: ClientService,
    generation: number,
    roomId: string,
    targetClient: TransferClient,
  ): Promise<void> {
    if (!this.isServiceCurrent(service, generation)) return;

    console.log("new client join in ", targetClient);
    const [error, session] = await catchError(
      this.options.sessions.addClient(targetClient),
    );

    if (error) {
      if (
        !(error instanceof DOMException) ||
        error.name !== "AbortError"
      ) {
        console.error(error);
      }
      return;
    }

    if (!this.isServiceCurrent(service, generation)) {
      session.close();
      return;
    }

    session.setStream(this.options.getLocalStream());
    this.options.rtc.bindSession(session);
    this.options.profiles.bindSession(session);

    const [listenError] = await catchError(
      session.listen(),
    );
    if (listenError) {
      if (this.isServiceCurrent(service, generation)) {
        console.error(listenError);
      }
      session.close();
      return;
    }

    if (!this.isServiceCurrent(service, generation)) {
      session.close();
      return;
    }

    this.options.messages.setClient(targetClient);
    this.options.onMemberJoined?.(roomId, targetClient);

    if (session.polite) return;

    const [connectError] = await catchError(
      session.connect(),
    );
    if (!connectError) return;

    if (this.isServiceCurrent(service, generation)) {
      console.error(connectError);
      if (
        Object.values(this.options.sessions.sessions)
          .length === 0
      ) {
        this.leave();
      }
    }
  }

  join(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        abortError("Room service is disposed"),
      );
    }

    const profile = {
      roomId: appState.profile.roomId,
      password: appState.profile.password,
      client: {
        clientId: appState.profile.clientId,
        name: appState.profile.name,
        avatar: appState.profile.avatar,
      },
    } satisfies ClientServiceInitOptions;

    const active = this.activeProfile;
    if (
      active &&
      (active.roomId !== profile.roomId ||
        active.password !== profile.password ||
        active.client.clientId !== profile.client.clientId)
    ) {
      this.leave();
    }

    if (this.pendingJoin) return this.pendingJoin;

    // Reserve ownership before the factory's first asynchronous step. A join
    // for another room or identity must retire even an uninstalled client.
    this.activeProfile = profile;
    const generation = this.generation;
    const promise = this.joinProfile(
      generation,
      profile,
    ).finally(() => {
      if (this.pendingJoin === promise)
        this.pendingJoin = null;
    });
    this.pendingJoin = promise;
    return promise;
  }

  private async joinProfile(
    generation: number,
    profile: ClientServiceInitOptions,
  ): Promise<void> {
    try {
      let service = this.options.sessions.clientService;
      if (!service) {
        service =
          await this.options.createClientService(profile);
        if (!this.isGenerationCurrent(generation)) {
          service.close();
          throw abortError(
            "Room changed while creating the client service",
          );
        }
        this.options.sessions.setClientService(service);
      }

      this.bindClientService(
        service,
        generation,
        profile.roomId,
      );
      await service.createClient();
      if (!this.isServiceCurrent(service, generation)) {
        throw abortError("Room changed while joining");
      }

      setAppState("roomStatus", {
        profile: service.info,
        roomId: profile.roomId,
        joinedAt:
          appState.roomStatus.roomId === profile.roomId
            ? (appState.roomStatus.joinedAt ?? Date.now())
            : Date.now(),
      });
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) {
        throw abortError("Room changed while joining");
      }
      this.leave();
      throw error;
    }
  }

  leave(): void {
    this.generation++;
    this.pendingJoin = null;
    this.boundService = null;
    this.boundGeneration = -1;
    this.activeProfile = null;

    this.options.onLeaving?.();

    const room = appState.roomStatus.roomId;
    if (room) {
      console.log(`on leave room ${room}`);
    }

    this.options.profiles.unbindAllSessions();
    this.options.rtc.unbindAllSessions();
    this.options.sessions.destoryAllSession();
    setAppState("roomStatus", {
      roomId: null,
      profile: null,
      joinedAt: null,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leave();
  }
}
