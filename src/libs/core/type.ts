export type RoomStatus = {
  roomId: RoomID | null;
  profile: ClientInfo | null;
};

export interface UpdateProfile {
  name?: string;
  roomId?: RoomID;
  clientId?: ClientID;
}

export type ClientServiceEventMap = {
  join: Client;
  leave: Client;
  update: Client;
};

export interface Client {
  clientId: ClientID;

  name: string;
  avatar: string | null;
}

export type TransferClient = Client & { createdAt: number };

export interface CreateClient extends Client {
  password?: string;
}

export interface ClientInfo extends TransferClient {
  statsReports?: any[];
  candidateType?: string;
  onlineStatus: "offline" | "online" | "connecting";
}
export type RoomID = string;
export type ClientID = string;
export type SessionID = string;

export type FileID = string;
