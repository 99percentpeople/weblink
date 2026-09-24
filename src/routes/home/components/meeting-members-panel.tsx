import { For, Show } from "solid-js";
import {
  FolderOpen,
  MessageSquare,
  Pin,
  PinOff,
  Volume2,
  VolumeX,
} from "lucide-solid";
import { ClientAvatar } from "@/components/common/client-avatar";
import { t } from "@/i18n";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import {
  appState,
  type ClientInfo,
} from "@/libs/state/app-state";
import { useAudioPlayer } from "./audio-player";

const rowClass = "flex min-w-0 items-center gap-1 py-1";
const identityClass =
  "flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-left";

export function MeetingMembersPanel(props: {
  clients: readonly ClientInfo[];
  roomId?: string | null;
  onOpenRoomChat?: () => void;
  onOpenChat(id: string): void;
  onOpenFiles(id: string): void;
  isPinned(id: string): boolean;
  onPin(id: string): void;
}) {
  const audio = useAudioPlayer();
  const { media } = useMeetingMedia();
  const localAudioLabel = () =>
    t(
      media.audioOn()
        ? "meeting.mute_local_audio"
        : "meeting.unmute_local_audio",
    );
  const roomAudioLabel = () =>
    t(
      audio.playState()
        ? "meeting.mute_room_audio"
        : "meeting.unmute_room_audio",
    );
  return (
    <div
      class="min-h-0 min-w-0 space-y-4 overflow-auto overscroll-contain
        p-3"
    >
      <Show when={props.onOpenRoomChat}>
        <div class={`${rowClass} bg-secondary rounded-md`}>
          <button
            type="button"
            class={`${identityClass} hover:bg-muted/60 transition-colors`}
            aria-label={t("meeting.open_room_chat")}
            onClick={() => props.onOpenRoomChat?.()}
          >
            <span
              class="bg-accent text-accent-foreground flex size-10 shrink-0
                items-center justify-center rounded-full"
              aria-hidden="true"
            >
              <MessageSquare class="size-5" />
            </span>
            <span class="min-w-0 flex-1 text-left">
              <span class="block truncate text-sm font-medium">
                {props.roomId}
              </span>
              <span class="text-muted-foreground mt-1 block truncate text-xs">
                {t("meeting.open_room_chat")}
              </span>
            </span>
          </button>
          <Show when={audio.hasAudio()}>
            <button
              type="button"
              class="meeting-icon-button"
              aria-pressed={!audio.playState()}
              aria-label={roomAudioLabel()}
              title={roomAudioLabel()}
              onClick={() =>
                audio.setPlay(!audio.playState())
              }
            >
              <Show
                when={audio.playState()}
                fallback={<VolumeX />}
              >
                <Volume2 />
              </Show>
            </button>
          </Show>
        </div>
      </Show>
      <p class="text-muted-foreground px-2 text-xs leading-relaxed">
        {t("meeting.members_hint")}
      </p>
      <ul
        class="space-y-1"
        aria-label={t("meeting.members")}
      >
        <li class={rowClass}>
          <div class={identityClass}>
            <ClientAvatar
              name={appState.profile.name}
              avatar={appState.profile.avatar ?? undefined}
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">
                {appState.profile.name}
              </p>
              <p class="text-muted-foreground mt-1 text-xs">
                {t("meeting.you")}
              </p>
            </div>
          </div>
          <Show when={media.audioAvailable()}>
            <button
              type="button"
              class="meeting-icon-button"
              aria-pressed={!media.audioOn()}
              aria-label={localAudioLabel()}
              title={localAudioLabel()}
              onClick={() =>
                media.setAudioEnabled(!media.audioOn())
              }
            >
              <Show
                when={media.audioOn()}
                fallback={<VolumeX />}
              >
                <Volume2 />
              </Show>
            </button>
          </Show>
        </li>
        <For each={props.clients}>
          {(client) => {
            const muted = () =>
              audio.isPeerMuted(client.clientId);
            const muteLabel = () =>
              t(
                muted()
                  ? "meeting.unmute_member"
                  : "meeting.mute_member",
                { name: client.name },
              );
            const pinLabel = () =>
              t(
                props.isPinned(client.clientId)
                  ? "meeting.unpin"
                  : "meeting.pin",
              );
            return (
              <li class={rowClass}>
                <button
                  type="button"
                  class={`${identityClass} hover:bg-muted/60 transition-colors`}
                  aria-label={t(
                    "meeting.open_private_chat",
                    { name: client.name },
                  )}
                  title={t("meeting.open_private_chat", {
                    name: client.name,
                  })}
                  onClick={() =>
                    props.onOpenChat(client.clientId)
                  }
                >
                  <ClientAvatar
                    class="shrink-0"
                    name={client.name}
                    avatar={client.avatar ?? undefined}
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">
                      {client.name}
                    </span>
                    <span class="text-muted-foreground mt-1 block text-xs">
                      {t(
                        `meeting.status_${client.onlineStatus}`,
                      )}
                    </span>
                  </span>
                </button>
                <Show
                  when={audio.hasPeerAudio(client.clientId)}
                >
                  <button
                    type="button"
                    class="meeting-icon-button"
                    aria-pressed={muted()}
                    aria-label={muteLabel()}
                    title={muteLabel()}
                    onClick={() =>
                      audio.setPeerMuted(
                        client.clientId,
                        !muted(),
                      )
                    }
                  >
                    <Show
                      when={muted()}
                      fallback={<Volume2 />}
                    >
                      <VolumeX />
                    </Show>
                  </button>
                </Show>
                <button
                  type="button"
                  class="meeting-icon-button"
                  aria-label={t("shared_files.title")}
                  title={t("shared_files.title")}
                  onClick={() =>
                    props.onOpenFiles(client.clientId)
                  }
                >
                  <FolderOpen />
                </button>
                <button
                  type="button"
                  class="meeting-icon-button"
                  aria-pressed={props.isPinned(
                    client.clientId,
                  )}
                  aria-label={pinLabel()}
                  title={pinLabel()}
                  onClick={() =>
                    props.onPin(client.clientId)
                  }
                >
                  <Show
                    when={props.isPinned(client.clientId)}
                    fallback={<Pin />}
                  >
                    <PinOff />
                  </Show>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </div>
  );
}
