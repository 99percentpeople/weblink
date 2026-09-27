import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import {
  ChevronRight,
  Settings,
  Users,
} from "lucide-solid";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";

function Metric(props: {
  label: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`min-w-0 ${props.class ?? ""}`}>
      <dt class="text-muted-foreground mb-1.5 text-xs">
        {props.label}
      </dt>
      <dd class="leading-relaxed [overflow-wrap:anywhere] tabular-nums">
        {props.children}
      </dd>
    </div>
  );
}

export function MeetingInfoPanel(props: {
  roomId?: string | null;
  active: boolean;
  onOpenSettings(): void;
}) {
  const state = useAppState();
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (
      !props.active ||
      appState.roomStatus.joinedAt == null
    )
      return;
    setNow(Date.now());
    const interval = window.setInterval(
      () => setNow(Date.now()),
      1000,
    );
    onCleanup(() => window.clearInterval(interval));
  });
  const elapsed = () => {
    const joinedAt = appState.roomStatus.joinedAt;
    if (!props.active || joinedAt == null) return "—";
    const seconds = Math.max(
      0,
      Math.floor((now() - joinedAt) / 1000),
    );
    return [
      Math.floor(seconds / 3600),
      Math.floor((seconds % 3600) / 60),
      seconds % 60,
    ]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  };
  const peers = createMemo(() =>
    props.active
      ? Object.values(
          appState.session.clientViewData,
        ).filter((peer) => peer?.onlineStatus === "online")
      : [],
  );
  const messagePeers = createMemo(() =>
    peers().filter((peer) => peer.messageChannel),
  );
  const supported = (kind: "text" | "file") => {
    const capabilities =
      kind === "text"
        ? state.roomChatCapabilities()
        : state.roomFileCapabilities();
    return messagePeers().filter(
      (peer) => capabilities[peer.clientId] === "supported",
    ).length;
  };
  const connected = () =>
    props.active &&
    appState.session.clientServiceStatus === "connected";
  const statusLabel = () => {
    if (
      appState.session.clientServiceStatus === "connecting"
    )
      return t(
        props.active
          ? "meeting.status_reconnecting"
          : "meeting.status_connecting",
      );
    if (!props.active) return t("meeting.not_joined");
    return t(
      connected()
        ? "meeting.status_online"
        : "meeting.status_offline",
    );
  };
  return (
    <div
      class="flex min-h-0 min-w-0 flex-col gap-5 overflow-auto
        overscroll-contain p-5 text-[13px]"
    >
      <header class="flex items-center gap-3">
        <span
          class="bg-accent text-accent-foreground grid size-11 shrink-0
            place-items-center rounded-md"
          aria-hidden="true"
        >
          <Users class="size-[22px]" />
        </span>
        <div class="min-w-0">
          <h2 class="text-[15px] font-semibold">
            {t("meeting.room_info")}
          </h2>
          <span
            class="text-muted-foreground data-[active]:text-primary mt-1
              inline-flex items-center gap-1.5 text-[11px] before:size-1.5
              before:rounded-full before:bg-current before:content-['']"
            data-active={connected() ? "" : undefined}
          >
            {statusLabel()}
          </span>
        </div>
      </header>

      <dl class="bg-muted/55 grid min-w-0 grid-cols-2 gap-4.5 rounded-md p-4">
        <Metric
          class="col-span-2"
          label={t("meeting.room_name")}
        >
          {props.roomId || t("meeting.not_joined")}
        </Metric>
        <Metric label={t("meeting.online_duration")}>
          {elapsed()}
        </Metric>
        <Metric label={t("room_dialog.online_members")}>
          {props.active
            ? peers().length + Number(connected())
            : "—"}
        </Metric>
        <Metric label={t("meeting.chat_support")}>
          {props.active
            ? `${supported("text")} / ${messagePeers().length}`
            : "—"}
        </Metric>
        <Metric label={t("meeting.file_support")}>
          {props.active
            ? `${supported("file")} / ${messagePeers().length}`
            : "—"}
        </Metric>
      </dl>

      <div class="flex flex-col gap-2.5 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          class="meeting-info-action"
          onClick={props.onOpenSettings}
        >
          <Settings aria-hidden="true" />
          <span>{t("room_dialog.open")}</span>
          <ChevronRight
            class="text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </div>
    </div>
  );
}
