import {
  createStore,
  reconcile,
  SetStoreFunction,
} from "solid-js/store";
import { PeerSession } from "../core/session";
import {
  ClientID,
  ClientInfo,
  Client,
  TransferClient,
} from "../core/type";
import { ClientService } from "../core/services/type";

class SessionService {
  readonly sessions: Record<ClientID, PeerSession>;
  readonly clientInfo: Record<ClientID, ClientInfo>;
  private setSessions: SetStoreFunction<
    Record<ClientID, PeerSession>
  >;
  private setClientInfo: SetStoreFunction<
    Record<ClientID, ClientInfo>
  >;
  private service?: ClientService;

  get clientService() {
    return this.service;
  }

  constructor() {
    const [sessions, setSessions] = createStore<
      Record<ClientID, PeerSession>
    >({});
    this.sessions = sessions;
    this.setSessions = setSessions;
    const [clientInfo, setClientInfo] = createStore<
      Record<ClientID, ClientInfo>
    >({});
    this.clientInfo = clientInfo;
    this.setClientInfo = setClientInfo;
  }

  setClientService(cs: ClientService) {
    this.service = cs;
  }

  destorySession(target: ClientID) {
    const session = this.sessions[target];
    if (!session) {
      console.log(
        `can not destory session, session ${target} not found`,
      );
      return;
    }
    session.destory();
    this.service?.removeSender(target);
    this.setClientInfo(target, undefined!);
    this.setSessions(target, undefined!);
  }

  addClient(client: TransferClient) {
    if (!this.service) {
      console.warn(
        `can not add client, client service not found`,
      );
      return;
    }
    if (this.sessions[client.clientId]) {
      console.log(
        `client ${client.clientId} has already created`,
      );
      return;
    }

    if (this.sessions[client.clientId]) {
      return;
    }

    const polite =
      this.service.info.createdAt < client.createdAt;

    const session = new PeerSession(
      this.service?.getSender(client.clientId),
      {
        polite,
      },
    );

    this.setClientInfo(client.clientId, {
      ...client,
      onlineStatus: "offline",
    } satisfies ClientInfo);
    this.setSessions(client.clientId, session);

    session.addEventListener("connecting", () => {
      this.setClientInfo(
        client.clientId,
        "onlineStatus",
        "connecting",
      );
    });

    session.addEventListener("connected", () => {
      this.setClientInfo(
        client.clientId,
        "onlineStatus",
        "online",
      );
    });

    session.addEventListener("close", () => {
      this.setClientInfo(
        client.clientId,
        "onlineStatus",
        "offline",
      );
    });

    session.addEventListener("reconnecting", async () => {
      await this.clientService?.createClient();
    });

    session.addEventListener("error", (ev) => {
      console.error(ev.detail);

      this.destorySession(session.clientId);
    });

    return session;
  }

  destoryAllSession() {
    Object.values(this.sessions).forEach((session) =>
      session.destory(),
    );
    this.setSessions(reconcile({}));
    this.setClientInfo(reconcile({}));
    this.service?.destroy();
    this.service = undefined;
  }
}

export const sessionService = new SessionService();
