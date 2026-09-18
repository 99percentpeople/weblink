import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { ClientInfo } from "@/libs/core/type";
import { getInitials } from "@/libs/utils/name";
import { RouteSectionProps } from "@solidjs/router";
import { createMemo, For } from "solid-js";
import { appState } from "@/libs/state/app-state";

const ShareClientItem = (props: { client: ClientInfo }) => {
  return (
    <li class="flex gap-2">
      <Avatar>
        <AvatarImage
          src={props.client.avatar ?? undefined}
        />
        <AvatarFallback seed={props.client.name}>
          {getInitials(props.client.name)}
        </AvatarFallback>
      </Avatar>
      <p>{props.client.name}</p>
    </li>
  );
};

const Share = (props: RouteSectionProps) => {
  const availableClients = createMemo(() =>
    Object.values(appState.session.clientViewData).filter(
      (client) => client.onlineStatus === "online",
    ),
  );

  return (
    <div class="container flex flex-col gap-2">
      <h2 class="h2">Share</h2>
      <ul>
        <For each={availableClients()}>
          {(item) => <ShareClientItem client={item} />}
        </For>
      </ul>
    </div>
  );
};

export default Share;
