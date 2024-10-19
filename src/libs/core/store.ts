import { makePersisted } from "@solid-primitives/storage";
import { createStore } from "solid-js/store";
import { faker } from "@faker-js/faker";
import { Client } from "./type";
import { v4 } from "uuid";
import { SignalingService } from "./services/type";
import { generateHMAC } from "./utils/hmac";
import { appOptions } from "@/options";

export interface ClientProfile extends Client {
  roomId: string;
  password: string | null;
  autoJoin: boolean;
  firstTime: boolean;
}

export async function getConfiguration() {
  const servers: RTCIceServer[] = [];
  for (const stun of appOptions.servers.stuns) {
    if (stun.trim().length === 0) continue;
    servers.push({
      urls: stun,
    });
  }
  if (appOptions.servers.turns)
    for (const turn of appOptions.servers.turns) {
      const { authMethod, username, password, url } = turn;
      if (url.trim().length === 0) continue;
      if (authMethod === "hmac") {
        const timestamp =
          Math.floor(Date.now() / 1000) + 24 * 3600;
        const hmacUsername = `${timestamp}`;
        const credential = await generateHMAC(
          password,
          hmacUsername,
        );
        servers.push({
          urls: url,
          username: hmacUsername,
          credential: credential,
        });
      } else if (authMethod === "longterm") {
        servers.push({
          urls: turn.url,
          username: username,
          credential: password,
        });
      } else {
        console.warn(
          `failed to add server ${url}, invalid method ${authMethod}`,
        );
      }
    }

  return {
    iceServers: servers,
    iceTransportPolicy: "all",
  } satisfies RTCConfiguration;
}

// this function is used to modify the offer
export async function handleOffer(
  pc: RTCPeerConnection,
  sender: SignalingService,
  options?: RTCOfferOptions,
) {
  const offer = await pc.createOffer(options);

  await pc.setLocalDescription(offer);
  await sender.sendSignal({
    type: offer.type,
    data: JSON.stringify({
      sdp: offer.sdp,
    }),
  });
}

export const getDefaultProfile = () => {
  return {
    roomId: faker.word.noun(),
    name: faker.person.firstName(),
    clientId: v4(),
    password: null,
    avatar: faker.image.avatar(),
    autoJoin: false,
    firstTime: true,
  };
};

export const [clientProfile, setClientProfile] =
  makePersisted(
    createStore<ClientProfile>(getDefaultProfile()),
    {
      name: "profile",
      storage: localStorage,
    },
  );

export const [clients, setClients] = makePersisted(
  createStore<Record<string, Client>>({}),
  {
    storage: localStorage,
    name: "clients",
  },
);
